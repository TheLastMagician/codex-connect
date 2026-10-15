import {Router,threadSnapshot} from './router.mjs';

export class FixedChatRouter extends Router {
  constructor({thread,...options}) {super({...options,operator:undefined});this.thread={...thread};}
  session(message) {
    const session=super.session(message);
    session.selected={...this.thread};session.mode='chat';session.awaitingChoice=null;
    return session;
  }
  async handle(message) {
    // All text is literal user input. No list, assistant, management or slash
    // command can change this bot's locally configured destination.
    return super.handle({...message,text:'/send '+message.text});
  }
  acceptCard() {return false;}
  async handleAction() {throw new Error('此机器人只支持聊天');}
  async poll() {
    for(const [key,watch] of [...this.watches]) {
      if(!this.getConfig().allowedOpenIds.includes(watch.openId) || watch.thread.id!==this.thread.id || (watch.thread.hostId||'local')!==(this.thread.hostId||'local')){this.watches.delete(key);continue;}
      try {
        const snapshot=threadSnapshot(await this.desktop.call('read_thread',{threadId:this.thread.id,...(this.thread.hostId?{hostId:this.thread.hostId}:{}),turnLimit:1,maxOutputCharsPerItem:20000}));
        const assistant=snapshot.latestAssistantMessage;
        if(snapshot.latestTurn?.status==='completed' && assistant?.text && assistant.id!==watch.messageId) {
          await this.send(watch.chatId,assistant.text,{kind:'assistant',openId:watch.openId});watch.messageId=assistant.id;
        }
        if(snapshot.thread?.status?.type==='needsAttention' && !watch.attentionNotified) {
          await this.send(watch.chatId,'这个会话需要你在 Codex 桌面处理审批或输入。',{kind:'notice',openId:watch.openId});watch.attentionNotified=true;
        }
        if(snapshot.thread?.status?.type!=='needsAttention')watch.attentionNotified=false;
        if(['completed','failed','interrupted'].includes(snapshot.latestTurn?.status) && snapshot.latestTurn?.id!==watch.baselineTurnId) {
          if(snapshot.latestTurn.status!=='completed')await this.send(watch.chatId,snapshot.latestTurn.status==='failed'?'会话执行失败，请在 Codex 桌面查看详情。':'这次会话已中断。',{kind:'notice',openId:watch.openId});
          this.watches.delete(key);
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
