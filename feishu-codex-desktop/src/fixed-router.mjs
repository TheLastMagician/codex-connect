import {Router,threadSnapshot,fingerprint} from './router.mjs';

const leases=new WeakMap();
const terminal=turn=>['completed','failed','interrupted'].includes(turn?.status);
const statusOf=thread=>typeof thread?.status==='string'?thread.status:thread?.status?.type;
const inputsOf=turn=>(turn?.items||[]).filter(item=>item.type==='userMessage').map(item=>
  Array.isArray(item.content)?item.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):item.text||'');

export class FixedChatRouter extends Router {
  constructor({thread,isActive=()=>true,...options}) {
    super({...options,operator:undefined});this.thread={...thread};this.isActive=isActive;
    this.state.fixedQueue ||= {pending:[],active:null};
    this.target=JSON.stringify([thread.hostId||'local',thread.id]);
    if(!leases.has(this.desktop))leases.set(this.desktop,new Map());
    this.leases=leases.get(this.desktop);
  }
  session(message) {
    const session=super.session(message);
    session.selected={...this.thread};session.mode='chat';session.awaitingChoice=null;
    return session;
  }
  live() {return !this.stopped && this.isActive();}
  meta(message,kind='notice') {return {kind,openId:message.openId,...(message.chatType==='group'?{chatType:'group',replyOpenIds:[message.openId]}:{})};}
  notify(message,text) {return this.send(message.chatId,text,this.meta(message));}
  acceptMessage(message) {
    if(!this.live() || !message?.id || !message.openId || !message.chatId || typeof message.text!=='string' || !message.text.trim() || message.text.length>12000
      || !Number.isFinite(message.timestamp) || Math.abs(this.now()-message.timestamp)>600000 || !this.authorized(message.openId))return false;
    const key=fingerprint(message);if(this.state.seen[key])return false;
    const queue=this.state.fixedQueue,ahead=queue.pending.length+(queue.active?1:0)+(this.watches.size?1:0);
    this.state.seen[key]=this.now();
    for(const [id,at] of Object.entries(this.state.seen))if(this.now()-at>86400000)delete this.state.seen[id];
    if(queue.pending.length>=100) {
      this.saveState();void this.notify(message,'等待队列已满，这条消息尚未接收，请稍后重新发送。').catch(()=>{});return false;
    }
    // Persist the input and its origin together with deduplication, before any
    // desktop write. A restart must neither lose queued input nor replay a write.
    const item={...message};queue.pending.push(item);this.saveState();
    if(ahead) {item.notified=true;this.saveState();void this.notify(item,`已排队，前面还有 ${ahead} 条请求。轮到你时会自动处理并回复。`).catch(()=>{});}
    void this.poll();return true;
  }
  acceptCard() {return false;}
  async handleAction() {throw new Error('此机器人只支持聊天');}
  stop() {this.stopped=true;if(!this.queues.has(this.target) && this.leases.get(this.target)===this)this.leases.delete(this.target);}
  poll() {
    const running=this.queues.get(this.target);if(running)return running;
    if(!this.live())return Promise.resolve();
    const work=Promise.resolve().then(()=>this.advance()).catch(()=>{
      // Retain the queue on transport/read failure. Never infer a completed turn
      // or repeat a possibly delivered native write from a timeout.
    }).finally(()=>{
      if(this.queues.get(this.target)===work)this.queues.delete(this.target);
      if((!this.live() || (!this.state.fixedQueue.active && !this.watches.size)) && this.leases.get(this.target)===this)this.leases.delete(this.target);
    });
    this.queues.set(this.target,work);return work;
  }
  async read() {return this.desktop.call('read_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),turnLimit:10,maxOutputCharsPerItem:20000});}
  async waitingNotice(message,text) {
    if(message.notified || !this.live() || !this.authorized(message.openId))return;
    message.notified=true;this.saveState();await this.notify(message,text);
  }
  async advance() {
    const queue=this.state.fixedQueue;
    if(!this.live() || (!queue.active && !queue.pending.length && !this.watches.size))return;
    const owner=this.leases.get(this.target);
    if(owner && owner!==this) {
      if(queue.pending[0])await this.waitingNotice(queue.pending[0],'已排队，这个会话正在处理其他请求；结束后会自动处理你的问题。');return;
    }
    this.leases.set(this.target,this);
    // Drain pre-queue-version notifications without replaying their tasks.
    if(this.watches.size){await this.pollLegacy();if(this.watches.size || !this.live())return;}
    if(queue.active) {
      const active=queue.active;
      if(!active.reply) {
        const result=await this.read();if(!this.live())return;
        const turns=result.turns||[];
        const turn=active.turnId?turns.find(t=>t.id===active.turnId):turns.find(t=>t.id!==active.baselineTurnId && (!active.baselineTurnIds?.includes(t.id)) &&
          (inputsOf(t).includes(active.message.text) || (active.phase==='waiting' && !inputsOf(t).length)));
        if(turn) {active.turnId=turn.id;this.saveState();}
        if(statusOf(result.thread)==='needsAttention' && !active.attentionNotified && this.authorized(active.message.openId)) {
          active.attentionNotified=true;this.saveState();await this.notify(active.message,'这个会话需要你在 Codex 桌面处理审批或输入；后续问题会继续排队。');
        }
        if(!turn || !terminal(turn))return;
        const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
        active.reply={kind:turn.status==='completed'?'assistant':'notice',text:turn.status==='completed'?(assistant?.text||'这次任务已完成，没有文字回复。'):
          turn.status==='failed'?'会话执行失败，请在 Codex 桌面查看详情。':'这次会话已中断。'};
        this.saveState();
      }
      if(!this.live())return;
      if(this.authorized(active.message.openId))await this.send(active.message.chatId,active.reply.text,this.meta(active.message,active.reply.kind));
      if(!this.live())return;
      queue.active=null;this.saveState();
    }
    while(queue.pending.length && !this.authorized(queue.pending[0].openId)){queue.pending.shift();this.saveState();}
    if(!queue.pending.length || !this.live())return;
    const message=queue.pending[0];let result;
    try {result=await this.read();}
    catch {await this.waitingNotice(message,'已排队，正在等待 Codex 连接恢复；恢复后会自动处理。');return;}
    if(!this.live() || !this.authorized(message.openId))return;
    const latest=result.turns?.[0],status=statusOf(result.thread);
    if(!['idle','notLoaded'].includes(status) || (latest && !terminal(latest))) {
      await this.waitingNotice(message,'已排队，会话正在处理前面的任务；结束后会自动处理你的问题。');return;
    }
    const active={message,phase:'sending',baselineTurnId:latest?.id,baselineTurnIds:(result.turns||[]).map(turn=>turn.id)};
    queue.pending.shift();queue.active=active;this.saveState();
    try {
      await this.desktop.call('send_message_to_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),prompt:message.text},
        {beforeSend:()=>{if(!this.live() || !this.authorized(message.openId))throw new Error('通道授权已撤销');}});
      active.phase='waiting';this.saveState();
    }catch(error) {
      if(error.notSent) {
        queue.active=null;queue.pending.unshift(message);this.saveState();
        await this.waitingNotice(message,'已排队，暂时无法连接目标会话；连接恢复后会自动处理。');
      }else {
        active.phase='uncertain';this.saveState();
        if(this.live() && this.authorized(message.openId))await this.notify(message,'暂时无法确认消息是否送达，已暂停后续队列以避免重复执行；正在等待桌面确认。');
      }
    }
  }
  async pollLegacy() {
    for(const [key,watch] of [...this.watches]) {
      const session=this.state.sessions[`${watch.openId}:${watch.chatId}`];
      const group=(watch.chatType||session?.chatType)==='group';
      const audience=()=>group?(watch.replyOpenIds||[watch.openId]).filter(id=>this.authorized(id)):[watch.openId].filter(id=>this.authorized(id));
      if(!audience().length || watch.thread.id!==this.thread.id || (watch.thread.hostId||'local')!==(this.thread.hostId||'local')){this.watches.delete(key);continue;}
      try {
        const snapshot=threadSnapshot(await this.desktop.call('read_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),turnLimit:1,maxOutputCharsPerItem:20000}));
        // A new request may replace this watch during the asynchronous read.
        if(this.watches.get(key)!==watch)continue;
        const people=audience();if(!people.length)continue;
        const meta={openId:people[0],...(group?{chatType:'group',replyOpenIds:people}:{})};
        const assistant=snapshot.latestAssistantMessage;
        if(snapshot.latestTurn?.status==='completed' && assistant?.text && assistant.id!==watch.messageId) {
          await this.send(watch.chatId,assistant.text,{...meta,kind:'assistant'});watch.messageId=assistant.id;
        }
        if(this.watches.get(key)!==watch)continue;
        if(snapshot.thread?.status?.type==='needsAttention' && !watch.attentionNotified) {
          await this.send(watch.chatId,'这个会话需要你在 Codex 桌面处理审批或输入。',{...meta,kind:'notice'});watch.attentionNotified=true;
        }
        if(this.watches.get(key)!==watch)continue;
        if(snapshot.thread?.status?.type!=='needsAttention')watch.attentionNotified=false;
        // Older versions steered multiple inputs into one turn, so its ID could
        // equal the baseline even after the final answer had already returned.
        if(terminal(snapshot.latestTurn) && (snapshot.latestTurn.id!==watch.baselineTurnId || ['idle','notLoaded'].includes(statusOf(snapshot.thread)))) {
          if(snapshot.latestTurn.status!=='completed')await this.send(watch.chatId,snapshot.latestTurn.status==='failed'?'会话执行失败，请在 Codex 桌面查看详情。':'这次会话已中断。',{...meta,kind:'notice'});
          if(this.watches.get(key)===watch)this.watches.delete(key);
        }
      }catch{/* Retry only notification reads after reconnection; never replay a task. */}
    }
    this.persistWatches();
  }
}
export function fixedReply(text,meta={}) {
  if(meta.command==='send')return null;
  if(meta.kind==='error')return /未确认|结果未知|超时/.test(meta.error?.message||text)
    ?'暂时没能确认这条消息是否已送达。请先在 Codex 桌面确认，避免重复发送。'
    :'这条消息暂时未能送达，请稍后重试。';
  return String(text);
}
