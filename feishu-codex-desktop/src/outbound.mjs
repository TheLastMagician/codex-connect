import {replyCard} from './cards.mjs';

export function chunkMarkdown(text,limit=3500) {
  const chars=Array.from(String(text));const parts=[];let offset=0;let fence=null;
  while(offset<chars.length) {
    const prefix=fence?`${fence.marker}${fence.info}\n`:'';
    const room=limit-Array.from(prefix).length-100;
    if(room<1) throw new Error('Markdown 分段长度过小');
    let count=Math.min(room,chars.length-offset);
    if(offset+count<chars.length) {
      const newline=chars.slice(offset,offset+count).lastIndexOf('\n');
      if(newline>room/2) count=newline+1;
    }
    const raw=chars.slice(offset,offset+count).join('');
    for(const line of raw.split('\n')) {
      const match=line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if(!match) continue;
      if(!fence) fence={marker:match[1],info:match[2].slice(0,80)};
      else if(match[1][0]===fence.marker[0] && match[1].length>=fence.marker.length && !match[2].trim()) fence=null;
    }
    parts.push(prefix+raw+(fence?'\n'+fence.marker:''));offset+=count;
  }
  return parts.length?parts:[''];
}

function conversationParts(conversation,limit=3500) {
  const pages=[];let messages=[];let size=0;
  for(const [index,message] of conversation.messages.entries()) {
    for(const [partIndex,text] of chunkMarkdown(message.text,limit).entries()) {
      const length=Array.from(text).length+100;
      if(messages.length && (size+length>limit || messages.length>=10)) {pages.push(messages);messages=[];size=0;}
      messages.push({...message,text,messageNumber:index+1,continuation:partIndex>0});size+=length;
    }
  }
  if(messages.length || !pages.length)pages.push(messages);
  const truncated=pages.length>20;
  return pages.slice(-20).map((messages,index)=>({conversation:{...conversation,messages},historyTruncated:truncated && index===0}));
}

export function createSender({client,actions,state,saveState,getConfig,canSend=()=>true}) {
  return async(chatId,text,meta={})=>{
    const session=meta.session||Object.values(state.sessions||{}).find(s=>s.chatId===chatId);
    const openId=meta.openId||session?.openId;
    const fullMeta={...meta,session};
    const parts=meta.kind==='conversation' && meta.conversation?conversationParts(meta.conversation):
      (meta.kind==='list'?[String(text)]:chunkMarkdown(text).slice(0,20)).map(text=>({text}));
    for(const [index,part] of parts.entries()) {
      if(!canSend(openId))return;
      const tokens=[];const issue=getConfig().cardActionsEnabled && openId?action=>{
        const token=actions.issue({chatId,openId},action);tokens.push(token);return token;
      }:undefined;
      const card=replyCard(part.text||'',{...fullMeta,...part,...(parts.length>1?{subtitle:`${meta.kind==='conversation'?'最近对话 · ':''}第 ${index+1} / ${parts.length} 部分`}:{})},index===parts.length-1?issue:undefined);
      saveState();
      const content=JSON.stringify(card);
      let result;let messageId;
      if(meta.updateMessageId && parts.length===1) {
        result=await client.im.v1.message.patch({path:{message_id:meta.updateMessageId},data:{content}});
        messageId=meta.updateMessageId;
      }
      if(!result || result.code!==0) {
        if(!canSend(openId))return;
        result=await client.im.v1.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content}});
        messageId=result.data?.message_id;
      }
      if(result.code!==0) throw new Error(`飞书卡片发送失败（${result.code}）：${result.msg||'请检查机器人权限'}`);
      if(tokens.length && messageId) actions.bind(tokens,messageId);
    }
  };
}
