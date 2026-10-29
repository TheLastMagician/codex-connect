import {chunkMarkdown} from './outbound.mjs';

const plain=content=>({tag:'plain_text',content:String(content)});
export function fixedMarkdown(text) {
  return String(text).replace(/\r\n?/g,'\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
    // Only real message senders may trigger mentions. Model-authored at tags
    // remain visible text rather than notifying somebody or the entire group.
    .replace(/<\s*\/?\s*at\b[^>]*>/gi,tag=>tag.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
}
export function fixedReplyCards(text,{botName='会话助手',kind='assistant',mentionIds=[]}={}) {
  const parts=chunkMarkdown(fixedMarkdown(text)).slice(0,20);
  const people=[...new Set(mentionIds.filter(id=>typeof id==='string' && /^ou_[A-Za-z0-9_-]{1,200}$/.test(id)))];
  const title=Array.from(botName||'会话助手').slice(0,40).join('');
  return parts.map((part,index)=>{
    const elements=[];
    if(index===0 && people.length)elements.push({tag:'markdown',content:'回复 '+people.map(id=>`<at id=${id}></at>`).join(' ')} ,{tag:'hr'});
    elements.push({tag:'markdown',content:part});
    return {schema:'2.0',config:{update_multi:true,summary:{content:title+(kind==='error'?' · 提示':' · 回复')}},
      header:{title:plain(title),subtitle:plain((kind==='assistant'?'回复':'提示')+(parts.length>1?` · 第 ${index+1} / ${parts.length} 部分`:'')),template:kind==='error'?'orange':'turquoise'},
      body:{direction:'vertical',padding:'16px 16px 16px 16px',elements}};
  });
}
