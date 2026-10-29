import {Router,threadSnapshot} from './router.mjs';
import {FixedChatRouter} from './fixed-router.mjs';
import {nativeTurnId} from './receipt-evidence.mjs';
import {taskModelArgs} from './models.mjs';

const targetKey=thread=>JSON.stringify([thread.hostId||'local',thread.id]);
const terminal=turn=>['completed','failed','interrupted'].includes(turn?.status);

// Commands retain their chat ordering. Ordinary input is handed to the same
// durable per-conversation executor used by fixed bots, without waiting for it.
export class ManagedChatRouter extends Router {
  constructor({isActive=()=>true,prepareInput,...options}) {
    super(options);this.isActive=isActive;this.prepareInput=prepareInput;this.workers=new Map();this.state.taskQueues ||= {};
    for(const entry of Object.values(this.state.taskQueues))if(entry.thread?.id)this.worker(entry.thread);
  }
  worker(thread) {
    const key=targetKey(thread);if(this.workers.has(key))return this.workers.get(key);
    const entry=this.state.taskQueues[key] ||= {thread:{...thread},sessions:{},seen:{},watches:{}};
    const send=(chatId,text,meta={})=>this.send(chatId,text,{...meta,kind:meta.kind==='notice'?'info':meta.kind,
      title:/发送结果|回执/.test(text)?'发送核对中':'消息队列',thread:{...entry.thread},
      session:this.state.sessions[`${meta.openId}:${chatId}`]});
    const worker=new FixedChatRouter({thread:entry.thread,desktop:this.desktop,state:entry,prepareInput:this.prepareInput,
      getConfig:this.getConfig,saveState:()=>this.saveState(),isActive:()=>!this.stopped && this.isActive(),
      isAuthorized:id=>this.authorized(id),now:this.now,send,
      readSnapshot:()=>this.readBeforeSend({selected:entry.thread},()=>{
        if(this.stopped || !this.isActive())throw new Error('通道已断开');
      }),
      beforeDispatch:()=>![...this.watches.values()].some(w=>w.receiptState && targetKey(w.thread)===key),
      onAccepted:message=>this.send(message.chatId,`已发送到：${entry.thread.title||entry.thread.id}\n回复会自动发回${this.channelLabel}。`,
        {kind:'info',title:'任务已发送',command:'send',thread:entry.thread,openId:message.openId,session:this.state.sessions[`${message.openId}:${message.chatId}`]}),
      onSendError:error=>this.noteDeliveryFailure('send',error,{selected:entry.thread}),
      deliverReply:(message,text,id,kind)=>this.sendWatchedReply({thread:entry.thread,openId:message.openId,chatId:message.chatId},text,id,kind==='assistant'?'assistant':'info'),
      matchTurn:async(result,active)=>{
        const baseline=result.turns?.find(t=>t.id===active.turnId);
        if(active.turnId===active.baselineTurnId && terminal(baseline) &&
          threadSnapshot({turns:[baseline]}).latestAssistantMessage?.id===active.baselineAssistantMessageId &&
          !(baseline.items||[]).some(i=>i.type==='userMessage' && (i.id===active.clientUserMessageId || i.clientId===active.clientUserMessageId)))return;
        active.receipt ||= {thread:entry.thread,openId:active.message.openId,chatId:active.message.chatId,
          clientUserMessageId:active.clientUserMessageId,createdAt:active.sentAt,submittedAt:active.submittedAt,evidence:active.evidence,receiptState:'uncertain'};
        if(nativeTurnId(active.turnId))active.receipt.confirmedTurnId=active.turnId;
        const reads=new Map([[JSON.stringify([`${entry.thread.hostId||'local'}:${entry.thread.id}`,null]),Promise.resolve(result)]]);
        return (await this.checkReceipt(active.receipt,reads,{allowUnauthorized:true}))?.turn;
      }});
    this.workers.set(key,worker);return worker;
  }
  async enqueueTask(message,session,prompt) {
    if(this.stopped || !this.isActive() || !this.authorized(message.openId))throw new Error('通道已断开，本条消息未加入队列。');
    const waiting=Object.values(this.state.taskQueues).reduce((n,e)=>n+(e.fixedQueue?.pending.length||0)+(e.fixedQueue?.active?1:0),0);
    if(waiting>=100)throw new Error('等待队列已满，本条消息尚未接收，请稍后重新发送。');
    const worker=this.worker({...this.selected(session)});
    // Do not copy connector tokens or unrelated event payloads into the queue.
    const accepted=worker.acceptMessage({id:message.id,openId:message.openId,chatId:message.chatId,text:prompt,
      ...(message.images?.length?{images:message.images.map(image=>({key:image.key}))}:{}),
      timestamp:message.timestamp??this.now(),...(message.chatType?{chatType:message.chatType}:{}),modelArgs:{...taskModelArgs(session)}});
    if(!accepted)throw new Error('本条消息未加入队列，请检查通道连接后重新发送。');
    session.awaitingChoice=null;this.saveState();
  }
  queueSummary(thread) {
    const queue=this.state.taskQueues[targetKey(thread)]?.fixedQueue;if(!queue)return '';
    const phase=queue.active?.phase;
    return `\n\n消息队列：${queue.pending.length} 条等待${phase?`；当前${phase==='preparing'?'等待连接':phase==='uncertain' || phase==='sending'?'核对发送结果':'等待回复'}`:''}${queue.deliveries?.length?`；${queue.deliveries.length} 条已完成回复待投递`:''}${queue.review?.length?`；${queue.review.length} 条此前消息待核对`:''}。`;
  }
  async poll() {
    if(this.stopped || !this.isActive())return;
    await super.poll();
    // Cold loading must not block other conversations or channel polling.
    for(const worker of this.workers.values())void worker.poll();
  }
  stop() {this.stopped=true;for(const worker of this.workers.values())worker.stop();}
}
