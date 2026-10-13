import {randomBytes} from 'node:crypto';

const TTL=6*60*60*1000;
export class CardActions {
  constructor({state,saveState,getConfig,now=Date.now}) {Object.assign(this,{state,saveState,getConfig,now});state.cardActions ||= {};}
  issue(owner,action) {
    for(const [token,record] of Object.entries(this.state.cardActions)) if(record.expiresAt<this.now()) delete this.state.cardActions[token];
    const token=randomBytes(16).toString('hex');
    this.state.cardActions[token]={...owner,action,expiresAt:this.now()+TTL};return token;
  }
  bind(tokens,messageId) {
    for(const token of tokens) if(this.state.cardActions[token]) this.state.cardActions[token].messageId=messageId;
    this.saveState();
  }
  consume(raw) {
    const event=raw.event||raw;const openId=event.operator?.open_id;
    const chatId=event.context?.open_chat_id||event.open_chat_id;
    const messageId=event.context?.open_message_id||event.open_message_id;
    const token=event.action?.value?.bridgeAction;const record=this.state.cardActions[token];
    const invalid=!record || !openId || !chatId || !messageId || !this.getConfig().allowedOpenIds.includes(openId) ||
      record.openId!==openId || record.chatId!==chatId || record.messageId!==messageId || record.expiresAt<this.now();
    if(invalid) return {toast:{type:'warning',content:'这个按钮已失效或不属于你的对话。请发送 /chats 刷新。'}};
    if(record.used) return {toast:{type:'info',content:'操作已收到，请看更新后的卡片。'}};
    record.used=true;this.saveState();
    return {context:{openId,chatId,id:`card-${token}`,updateMessageId:messageId,action:record.action},
      toast:{type:'success',content:'正在处理…'}};
  }
}
