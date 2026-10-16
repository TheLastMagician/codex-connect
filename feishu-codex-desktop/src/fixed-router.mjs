import {Router,threadSnapshot,fingerprint} from './router.mjs';
import {randomUUID} from 'node:crypto';

const leases=new WeakMap();
const terminal=turn=>['completed','failed','interrupted'].includes(turn?.status);
const statusOf=thread=>typeof thread?.status==='string'?thread.status:thread?.status?.type;
const idle=snapshot=>['idle','notLoaded'].includes(statusOf(snapshot.thread)) && (!snapshot.turns?.[0] || terminal(snapshot.turns[0]));
const UNCONFIRMED_GRACE_MS=120000,IDLE_CONFIRM_MS=15000;
const inputsOf=turn=>(turn?.items||[]).filter(item=>item.type==='userMessage').map(item=>
  Array.isArray(item.content)?item.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):item.text||'');

export class FixedChatRouter extends Router {
  constructor({thread,isActive=()=>true,...options}) {
    super({...options,operator:undefined});this.thread={...thread};this.isActive=isActive;
    this.state.fixedQueue ||= {pending:[],active:null};
    this.state.fixedQueue.review ||= [];
    if(this.state.fixedQueue.active) {delete this.state.fixedQueue.active.idleSince;delete this.state.fixedQueue.active.idleSnapshot;}
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
    if(!ahead)delete queue.autoOpenAttempted;
    this.state.seen[key]=this.now();
    for(const [id,at] of Object.entries(this.state.seen))if(this.now()-at>86400000)delete this.state.seen[id];
    if(queue.pending.length>=100) {
      this.saveState();void this.notify(message,'等待队列已满，这条消息尚未接收，请稍后重新发送。').catch(()=>{});return false;
    }
    // Persist the input and its origin together with deduplication, before any
    // desktop write. A restart must neither lose queued input nor replay a write.
    const item={...message};queue.pending.push(item);this.saveState();
    if(ahead) {item.notified=true;this.saveState();void this.notify(item,queue.active && ['uncertain','sending'].includes(queue.active.phase)
      ?'前一条发送结果正在核对，你的消息已保存等待；这不表示 Codex 仍在执行。确认会话空闲后会继续处理。'
      :queue.blockedReason==='connection'?'暂时无法连接目标会话，你的消息已保存；连接恢复后会按顺序发送。'
      :`已排队，前面还有 ${ahead} 条请求。轮到你时会自动处理并回复。`).catch(()=>{});}
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
  async waitingNotice(message,text,reason='connection') {
    this.state.fixedQueue.blockedReason=reason;
    if(message.waitReason===reason || !this.live() || !this.authorized(message.openId)){this.saveState();return;}
    message.waitReason=reason;message.notified=true;this.saveState();await this.notify(message,text);
  }
  findTurn(result,active) {
    const turns=result.turns||[];
    if(active.turnId) {
      const turn=turns.find(turn=>turn.id===active.turnId);
      if(turn?.id===active.baselineTurnId && terminal(turn) && threadSnapshot({turns:[turn]}).latestAssistantMessage?.id===active.baselineAssistantMessageId &&
        !(turn.items||[]).some(item=>item.type==='userMessage' && item.id===active.clientUserMessageId))return;
      return turn;
    }
    return turns.find(turn=>(active.clientUserMessageId && (turn.items||[]).some(item=>item.type==='userMessage' && item.id===active.clientUserMessageId)) ||
      (turn.id!==active.baselineTurnId && !active.baselineTurnIds?.includes(turn.id) &&
      (inputsOf(turn).includes(active.message.text) || (active.phase==='waiting' && !inputsOf(turn).length))));
  }
  async pollReviews() {
    const queue=this.state.fixedQueue;if(!queue.review.length)return;
    const result=await this.read();if(!this.live())return;
    for(const record of [...queue.review]) {
      const turn=this.findTurn(result,record);if(!turn || !terminal(turn))continue;
      const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
      if(this.authorized(record.message.openId))await this.send(record.message.chatId,'此前待核对消息的结果：\n\n'+
        (turn.status==='completed'?(assistant?.text||'任务已完成，没有文字回复。'):turn.status==='failed'?'会话执行失败，请在桌面查看详情。':'这次会话已中断。'),this.meta(record.message,turn.status==='completed'?'assistant':'notice'));
      if(!this.live())return;
      queue.review=queue.review.filter(item=>item!==record);this.saveState();
    }
  }
  async reviewUnmatched(active,result) {
    const since=active.sentAt??active.message.timestamp;
    if(!idle(result) || this.now()-since<UNCONFIRMED_GRACE_MS) {
      delete active.idleSince;delete active.idleSnapshot;this.saveState();return false;
    }
    const stamp=result.turns?.[0]?.id||'empty';
    if(active.idleSince===undefined || active.idleSnapshot!==stamp) {active.idleSince=this.now();active.idleSnapshot=stamp;this.saveState();return false;}
    if(this.now()-active.idleSince<IDLE_CONFIRM_MS)return false;
    const queue=this.state.fixedQueue;
    // This is unresolved delivery, not a completed task. Keep its input for
    // later reconciliation, never replay it, and stop claiming the desktop is busy.
    queue.review.push({...active,reviewedAt:this.now()});queue.active=null;this.saveState();
    if(this.authorized(active.message.openId))await this.notify(active.message,'此前这条消息的发送或回复暂时无法核对，原文已保留，不会自动重发。已连续确认会话空闲，后续请求继续处理。').catch(()=>{});
    return true;
  }
  async advance() {
    const queue=this.state.fixedQueue;
    if(!this.live())return;
    await this.pollReviews().catch(()=>{});if(!this.live() || (!queue.active && !queue.pending.length && !this.watches.size))return;
    const owner=this.leases.get(this.target);
    if(owner && owner!==this) {
      if(queue.pending[0])await this.waitingNotice(queue.pending[0],'已排队，这个会话正在处理其他请求；结束后会自动处理你的问题。','busy');return;
    }
    this.leases.set(this.target,this);
    // Drain pre-queue-version notifications without replaying their tasks.
    if(this.watches.size){await this.pollLegacy();if(this.watches.size || !this.live())return;}
    if(queue.active) {
      const active=queue.active;
      if(!active.reply) {
        let result;
        try {result=await this.read();}
        catch {delete active.idleSince;delete active.idleSnapshot;this.saveState();return;}
        if(!this.live())return;
        const turn=this.findTurn(result,active);
        if(turn) {active.turnId=turn.id;this.saveState();}
        if(statusOf(result.thread)==='needsAttention' && !active.attentionNotified && this.authorized(active.message.openId)) {
          active.attentionNotified=true;this.saveState();await this.notify(active.message,'这个会话需要你在 Codex 桌面处理审批或输入；后续问题会继续排队。');
        }
        if(!turn) {
          if(!await this.reviewUnmatched(active,result))return;
        }else {
          delete active.idleSince;delete active.idleSnapshot;
          if(!terminal(turn))return;
          const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
          active.reply={kind:turn.status==='completed'?'assistant':'notice',text:turn.status==='completed'?(assistant?.text||'这次任务已完成，没有文字回复。'):
            turn.status==='failed'?'会话执行失败，请在 Codex 桌面查看详情。':'这次会话已中断。'};
          this.saveState();
        }
      }
      if(queue.active) {
        if(!this.live())return;
        if(this.authorized(active.message.openId))await this.send(active.message.chatId,active.reply.text,this.meta(active.message,active.reply.kind));
        if(!this.live())return;
        queue.active=null;this.saveState();
      }
    }
    while(queue.pending.length && !this.authorized(queue.pending[0].openId)){queue.pending.shift();this.saveState();}
    if(!queue.pending.length || !this.live())return;
    const message=queue.pending[0];let result;
    try {result=await this.read();}
    catch {await this.waitingNotice(message,'已排队，正在等待 Codex 连接恢复；恢复后会自动处理。');return;}
    if(!this.live() || !this.authorized(message.openId))return;
    const latest=result.turns?.[0],status=statusOf(result.thread);
    if(!['idle','notLoaded'].includes(status) || (latest && !terminal(latest))) {
      await this.waitingNotice(message,'已排队，会话正在处理前面的任务；结束后会自动处理你的问题。','busy');return;
    }
    const active={message,phase:'sending',sentAt:this.now(),clientUserMessageId:randomUUID(),baselineTurnId:latest?.id,
      baselineAssistantMessageId:threadSnapshot(result).latestAssistantMessage?.id,baselineTurnIds:(result.turns||[]).map(turn=>turn.id)};
    queue.pending.shift();queue.active=active;delete queue.blockedReason;this.saveState();
    try {
      const receipt=await this.desktop.call('send_message_to_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),prompt:message.text,clientUserMessageId:active.clientUserMessageId},
        {beforeSend:()=>{if(!this.live() || !this.authorized(message.openId))throw new Error('通道授权已撤销');},
          beforeActivate:()=>{
            if(!this.live() || !this.authorized(message.openId))throw new Error('通道授权已撤销');
            if(queue.autoOpenAttempted)return false;
            queue.autoOpenAttempted=true;this.saveState();return true;
          },
          beforeSubmit:async()=>{
            const fresh=await this.read();
            if(!this.live() || !this.authorized(message.openId))throw new Error('通道授权已撤销');
            if(!idle(fresh))throw Object.assign(new Error('会话正在执行，消息尚未发送。'),{code:'THREAD_BUSY'});
            active.baselineTurnId=fresh.turns?.[0]?.id;
            active.baselineAssistantMessageId=threadSnapshot(fresh).latestAssistantMessage?.id;
            active.baselineTurnIds=(fresh.turns||[]).map(turn=>turn.id);this.saveState();
          }});
      active.phase='waiting';if(typeof receipt?.turnId==='string')active.turnId=receipt.turnId;this.saveState();
    }catch(error) {
      if(error.notSent) {
        queue.active=null;queue.pending.unshift(message);this.saveState();
        await this.waitingNotice(message,error.code==='THREAD_BUSY'
          ?'已排队，会话正在处理前面的任务；结束后会自动处理你的问题。'
          :'已排队，暂时无法连接目标会话；连接恢复后会自动处理。',error.code==='THREAD_BUSY'?'busy':'connection');
      }else {
        active.phase='uncertain';this.saveState();
        if(this.live() && this.authorized(message.openId))await this.notify(message,'消息发送结果待确认，正在核对桌面状态。原消息已保存，不会自动重发；这不表示会话仍在执行。');
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
