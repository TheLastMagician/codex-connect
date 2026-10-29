import {replyCard} from './cards.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {feishuResult,feishuFailure} from './feishu-media.mjs';

// A completed reply can be retried independently of its Codex task. Remember
// acknowledged parts, and use Feishu's five-minute UUID window for lost ACKs.
export function createCardWriter({client,state,saveState,canSend=()=>true,report=()=>{},now=Date.now,namespace=''}) {
  return async({chatId,openId,card,deliveryId,index=0,updateMessageId})=>{
    const key=deliveryId?createHash('sha256').update(JSON.stringify([namespace,chatId,deliveryId,index])).digest('hex'):null;
    const prior=key && state.feishuReplyParts?.[key];
    if(prior?.delivered)return prior.messageId;
    if(prior?.uncertain && now()-prior.at>240000)throw Object.assign(new Error('飞书发送结果待核对，保留回复且不重复发送'),{code:'FEISHU_DELIVERY_UNCERTAIN'});
    const record=prior||{uuid:randomUUID(),at:now()};
    if(!canSend(openId))return;
    const content=JSON.stringify(card);
    try {
      let result;
      if(updateMessageId){result=await client.im.v1.message.patch({path:{message_id:updateMessageId},data:{content}},{timeout:15000});if(result?.code===0)return updateMessageId;}
      if(!canSend(openId))return;
      if(key){record.uncertain=true;state.feishuReplyParts={...state.feishuReplyParts,[key]:record};saveState();}
      result=await client.im.v1.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content,uuid:record.uuid}},{timeout:15000});
      if(result?.code!==0){record.uncertain=false;feishuResult(result);}
      const messageId=result.data?.message_id;
      if(key){state.feishuReplyParts[key]={uuid:record.uuid,at:now(),delivered:true,messageId};
        // Never discard an unresolved receipt to make room for another reply.
        const delivered=Object.entries(state.feishuReplyParts).filter(([,p])=>p.delivered).slice(-1000);
        state.feishuReplyParts={...Object.fromEntries(delivered),...Object.fromEntries(Object.entries(state.feishuReplyParts).filter(([,p])=>!p.delivered))};saveState();}
      return messageId;
    }catch(error){if(error?.response?.data?.code)record.uncertain=false;if(key)saveState();report({...feishuFailure(error),at:now()});throw error;}
  };
}

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

export function createSender({client,actions,state,saveState,getConfig,canSend=()=>true,prepareText=async text=>String(text),writeCard}) {
  writeCard ||= createCardWriter({client,state,saveState,canSend});
  return async(chatId,text,meta={})=>{
    const session=meta.session||Object.values(state.sessions||{}).find(s=>s.chatId===chatId);
    const openId=meta.openId||session?.openId;
    const fullMeta={...meta,session};
    if(!canSend(openId))return;
    if(meta.kind==='conversation' && meta.conversation){
      const messages=[];for(const message of meta.conversation.messages)messages.push({...message,text:await prepareText(message.text,{thread:meta.thread||session?.selected,openId})});
      meta={...meta,conversation:{...meta.conversation,messages}};
    }else if(meta.kind==='assistant')text=await prepareText(text,{thread:meta.thread||session?.selected,openId,deliveryId:meta.deliveryId});
    const parts=meta.kind==='conversation' && meta.conversation?conversationParts(meta.conversation):
      (meta.kind==='list'?[String(text)]:chunkMarkdown(text).slice(0,20)).map(text=>({text}));
    for(const [index,part] of parts.entries()) {
      if(!canSend(openId))return;
      const tokens=[];const issue=getConfig().cardActionsEnabled && openId?action=>{
        const token=actions.issue({chatId,openId},action);tokens.push(token);return token;
      }:undefined;
      const card=replyCard(part.text||'',{...fullMeta,...part,...(parts.length>1?{subtitle:`${meta.kind==='conversation'?'最近对话 · ':''}第 ${index+1} / ${parts.length} 部分`}:{})},index===parts.length-1?issue:undefined);
      saveState();
      const messageId=await writeCard({chatId,openId,card,deliveryId:meta.deliveryId,index,updateMessageId:parts.length===1?meta.updateMessageId:undefined});
      if(tokens.length && messageId) actions.bind(tokens,messageId);
    }
  };
}
