import {Router,threadSnapshot,fingerprint} from './router.mjs';
import {randomUUID} from 'node:crypto';
import {targetLeases} from './target-leases.mjs';
import {receiptEvidence} from './receipt-evidence.mjs';

const terminal=turn=>['completed','failed','interrupted'].includes(turn?.status);
const statusOf=thread=>typeof thread?.status==='string'?thread.status:thread?.status?.type;
const idle=snapshot=>['idle','notLoaded'].includes(statusOf(snapshot.thread)) && (!snapshot.turns?.[0] || terminal(snapshot.turns[0]));
const UNCONFIRMED_GRACE_MS=120000,IDLE_CONFIRM_MS=15000,RECEIPT_NOTICE_MS=30000;
const inputsOf=turn=>(turn?.items||[]).filter(item=>item.type==='userMessage').map(item=>
  Array.isArray(item.content)?item.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):item.text||'');

export class FixedChatRouter extends Router {
  constructor({thread,isActive=()=>true,matchTurn,beforeDispatch,onAccepted,onSendError,deliverReply,readSnapshot,...options}) {
    super(options);Object.assign(this,{thread:{...thread},isActive,matchTurn,beforeDispatch,onAccepted,onSendError,deliverReply,readSnapshot});
    this.state.fixedQueue ||= {pending:[],active:null};
    this.state.fixedQueue.review ||= [];
    this.state.fixedQueue.deliveries ||= [];
    if(this.state.fixedQueue.active?.phase==='preparing') {
      this.state.fixedQueue.pending.unshift(this.state.fixedQueue.active.message);this.state.fixedQueue.active=null;this.saveState();
    }
    if(this.state.fixedQueue.active) {delete this.state.fixedQueue.active.idleSince;delete this.state.fixedQueue.active.idleSnapshot;}
    this.target=JSON.stringify([thread.hostId||'local',thread.id]);
    this.leases=targetLeases(this.desktop);
  }
  session(message) {
    const session=super.session(message);
    session.selected={...this.thread};session.awaitingChoice=null;
    return session;
  }
  live() {return !this.stopped && this.isActive();}
  meta(message,kind='notice') {return {kind,openId:message.openId,...(message.chatType==='group'?{chatType:'group',replyOpenIds:[message.openId]}:{})};}
  notify(message,text) {return this.send(message.chatId,text,this.meta(message));}
  reply(message,text,assistantId,kind='assistant') {
    return this.deliverReply?this.deliverReply(message,text,assistantId,kind):this.send(message.chatId,text,
      {...this.meta(message,kind),deliveryId:fingerprint({id:JSON.stringify([message.id,assistantId])})});
  }
  parkReply(active) {
    const queue=this.state.fixedQueue,id=active.clientUserMessageId||active.message.id;
    if(!queue.deliveries.some(job=>job.id===id))queue.deliveries.push({id,message:active.message,reply:active.reply,turnId:active.turnId,createdAt:this.now(),attempts:0});
    queue.active=null;this.saveState();
  }
  pollDeliveries() {
    if(this.deliveryWork)return this.deliveryWork;
    const work=Promise.resolve().then(async()=>{
      const queue=this.state.fixedQueue,seenChats=new Set();
      for(const job of [...queue.deliveries]) {
        if(!this.live())return;
        if(!this.authorized(job.message.openId)){queue.deliveries=queue.deliveries.filter(item=>item!==job);this.saveState();continue;}
        // Preserve reply order in each original chat, without blocking other chats.
        if(seenChats.has(job.message.chatId))continue;seenChats.add(job.message.chatId);
        if((job.nextAttemptAt||0)>this.now())continue;
        job.attempts++;job.lastAttemptAt=this.now();this.saveState();
        try {
          await this.reply(job.message,job.reply.text,job.reply.id||job.turnId,job.reply.kind);
          if(!this.live())return;
          queue.deliveries=queue.deliveries.filter(item=>item!==job);this.saveState();
        }catch(error){
          const code=Number(error?.response?.data?.code??error?.data?.code);
          job.lastError={at:this.now(),...(Number.isInteger(code) && code!==0?{code}:{}),
            ...(error?.code==='FEISHU_DELIVERY_UNCERTAIN'?{reason:'delivery_unknown'}:{})};
          job.nextAttemptAt=this.now()+Math.min(60000,5000*2**Math.min(job.attempts-1,4));this.saveState();
        }
      }
    }).catch(()=>{}).finally(()=>{if(this.deliveryWork===work)this.deliveryWork=null;});
    this.deliveryWork=work;return work;
  }
  matchingTurn(result,active) {return this.matchTurn?this.matchTurn(result,active):this.findTurn(result,active);}
  acceptMessage(message) {
    if(!this.live() || !message?.id || !message.openId || !message.chatId || typeof message.text!=='string' || !message.text.trim() || message.text.length>12000
      || !Number.isFinite(message.timestamp) || Math.abs(this.now()-message.timestamp)>600000 || !this.authorized(message.openId))return false;
    const key=fingerprint(message);if(this.state.seen[key])return false;
    const queue=this.state.fixedQueue,ahead=queue.pending.length+(queue.active?1:0)+(this.watches.size?1:0);
    if(!ahead){delete queue.autoOpenAttempted;delete queue.desktopWakeAttempted;}
    this.state.seen[key]=this.now();
    for(const [id,at] of Object.entries(this.state.seen))if(this.now()-at>86400000)delete this.state.seen[id];
    if(queue.pending.length>=100) {
      this.saveState();void this.notify(message,'等待队列已满，这条消息尚未接收，请稍后重新发送。').catch(()=>{});return false;
    }
    // Persist the input and its origin together with deduplication, before any
    // desktop write. A restart must neither lose queued input nor replay a write.
    const item={...message};queue.pending.push(item);this.saveState();
    if(ahead) {item.notified=true;this.saveState();void this.notify(item,queue.active?.uncertainNotified && ['uncertain','sending'].includes(queue.active.phase)
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
  async read() {
    const read=()=>this.readSnapshot?this.readSnapshot():this.desktop.call('read_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),turnLimit:10,maxOutputCharsPerItem:20000});
    try {return await read();}
    catch(error) {
      const queue=this.state.fixedQueue;
      const message=queue.active?.message||queue.pending[0]||queue.review.find(item=>this.authorized(item.message.openId))?.message;
      if(!message || !this.desktop.recoverForThread || queue.desktopWakeAttempted)throw error;
      const authorize=()=>{if(!this.live() || !this.authorized(message.openId))throw new Error('通道已断开或授权已撤销');};
      try {
        const opened=await this.desktop.recoverForThread(this.thread,{authorize,beforeWake:()=>{
          authorize();if(queue.desktopWakeAttempted)return false;
          // Save before navigation so restarts and all retries in this batch
          // cannot repeatedly steal focus. This never submits or resends input.
          queue.desktopWakeAttempted=true;queue.autoOpenAttempted=true;this.saveState();return true;
        }});
        authorize();if(opened)return await read();
      }catch{/* Keep the original failure and durable queue until recovery. */}
      throw error;
    }
  }
  async accepted(active,turnId,finished=false) {
    active.phase='waiting';if(typeof turnId==='string')active.turnId=turnId;this.saveState();
    if(active.acceptedNotified)return;
    active.acceptedNotified=true;this.saveState();
    if(!finished && this.live() && this.authorized(active.message.openId)) {
      try {await this.onAccepted?.(active.message,{accepted:true,turnId:active.turnId});}
      catch{/* Notification failure must never replay a native write. */}
    }
  }
  async receiptNotice(active) {
    if(!['uncertain','sending'].includes(active.phase) || active.uncertainNotified || !this.live() || !this.authorized(active.message.openId) ||
      this.now()-(active.uncertainSince??active.submittedAt??active.sentAt)<RECEIPT_NOTICE_MS)return;
    await this.notify(active.message,'暂时还无法确认消息发送结果，正在后台核对。请不要重复发送；核对到结果后会自动回复。');
    active.uncertainNotified=true;this.saveState();
  }
  async reconcileAfterTimeout(active) {
    try {
      const result=await this.read();if(!this.live() || this.state.fixedQueue.active!==active)return;
      const turn=await this.matchingTurn(result,active);
      if(turn && this.live() && this.state.fixedQueue.active===active)await this.accepted(active,turn.id,terminal(turn));
    }catch{/* Only inspect history; a missing receipt must never trigger another write. */}
  }
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
      const turn=await this.matchingTurn(result,record);if(!turn || !terminal(turn))continue;
      const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
      if(this.authorized(record.message.openId))await this.reply(record.message,'此前待核对消息的结果：\n\n'+
        (turn.status==='completed'?(assistant?.text||'任务已完成，没有文字回复。'):turn.status==='failed'?'会话执行失败，请在桌面查看详情。':'这次会话已中断。'),assistant?.id||turn.id,turn.status==='completed'?'assistant':'notice');
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
    // Upgrade saved completed replies before doing any I/O. Delivery failures
    // must never hold the execution lease or cause a model task to be replayed.
    if(queue.active?.reply)this.parkReply(queue.active);
    void this.pollDeliveries();
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
        catch {delete active.idleSince;delete active.idleSnapshot;this.saveState();await this.receiptNotice(active);return;}
        if(!this.live())return;
        const turn=await this.matchingTurn(result,active);
        if(turn) {
          if(['uncertain','sending'].includes(active.phase))await this.accepted(active,turn.id,terminal(turn));
          else {active.turnId=turn.id;this.saveState();}
        }
        if(statusOf(result.thread)==='needsAttention' && !active.attentionNotified && this.authorized(active.message.openId)) {
          active.attentionNotified=true;this.saveState();await this.notify(active.message,'这个会话需要你在 Codex 桌面处理审批或输入；后续问题会继续排队。');
        }
        if(!turn) {
          if(!await this.reviewUnmatched(active,result)){await this.receiptNotice(active);return;}
        }else {
          delete active.idleSince;delete active.idleSnapshot;
          if(!terminal(turn))return;
          const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
          active.reply={id:assistant?.id||turn.id,kind:turn.status==='completed'?'assistant':'notice',text:turn.status==='completed'?(assistant?.text||'这次任务已完成，没有文字回复。'):
            turn.status==='failed'?'会话执行失败，请在 Codex 桌面查看详情。':'这次会话已中断。'};
          this.saveState();
        }
      }
      if(queue.active) {
        if(!this.live())return;
        this.parkReply(active);void this.pollDeliveries();
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
    if(this.beforeDispatch && !await this.beforeDispatch(result)) {
      await this.waitingNotice(message,'前一条发送回执仍在核对，你的消息已保存等待。','receipt');return;
    }
    if(!this.live() || !this.authorized(message.openId))return;
    const active={message,phase:'preparing',sentAt:this.now(),clientUserMessageId:randomUUID(),baselineTurnId:latest?.id,
      evidence:receiptEvidence(message.text,result.turns||[]),
      baselineAssistantMessageId:threadSnapshot(result).latestAssistantMessage?.id,baselineTurnIds:(result.turns||[]).map(turn=>turn.id)};
    queue.pending.shift();queue.active=active;delete queue.blockedReason;this.saveState();
    try {
      const receipt=await this.desktop.call('send_message_to_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),prompt:message.text,clientUserMessageId:active.clientUserMessageId,...message.modelArgs},
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
            active.phase='sending';active.submittedAt=this.now();active.evidence=receiptEvidence(message.text,fresh.turns||[]);this.saveState();
          }});
      await this.accepted(active,receipt?.turnId);
    }catch(error) {
      this.onSendError?.(error,message);
      if(error.notSent) {
        queue.active=null;queue.pending.unshift(message);this.saveState();
        await this.waitingNotice(message,error.code==='THREAD_BUSY'
          ?'已排队，会话正在处理前面的任务；结束后会自动处理你的问题。'
          :'已排队，暂时无法连接目标会话；连接恢复后会自动处理。',error.code==='THREAD_BUSY'?'busy':'connection');
      }else {
        active.phase='uncertain';active.uncertainSince=this.now();this.saveState();
        // The desktop's start-turn ACK can time out while the actual turn is
        // already running. Inspect its history before alarming the sender.
        await this.reconcileAfterTimeout(active);
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
