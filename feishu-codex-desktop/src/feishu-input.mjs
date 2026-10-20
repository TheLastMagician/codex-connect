// Feishu can send visible text as either text or post. Flatten only documented
// textual nodes; do not treat an audio file key or card payload as an instruction.
const LIMIT=12000;
const decode=value=>{
  if(typeof value==='string'){if(value.length>256000)return;try{return JSON.parse(value);}catch{return;}}
  return value && typeof value==='object' && !Array.isArray(value)?value:undefined;
};
function mentionText(id,name,mentions) {
  const mention=mentions.find(item=>item.id?.open_id===id || item.key===id);
  if(mention)return mention.key;
  return '@'+(typeof name==='string' && name?name:id||'用户');
}
function markdownText(text,mentions) {
  return text.replace(/<at\s+user_id\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*>[\s\S]*?<\/at>/g,
    (tag,a,b,c)=>mentionText(a||b||c,'',mentions));
}
function postText(body,mentions) {
  if(!body || typeof body!=='object' || Array.isArray(body))return;
  // Receive payloads have title/content directly; some clients retain a locale.
  if(!Array.isArray(body.content) && !Array.isArray(body.content_v2))body=body.zh_cn||body.en_us||body.ja_jp;
  if(!body)return;
  for(const rows of [body.content_v2,body.content]) {
    const text=postRows(rows,body.title,mentions);
    if(typeof text==='string' && text.trim() && text.length<=LIMIT)return text;
  }
}
function postRows(rows,title,mentions) {
  if(!Array.isArray(rows) || rows.length>400)return;
  const paragraphs=[];let length=0,nodes=0,hasText=false;
  if(typeof title==='string' && title){if(title.length>LIMIT)return;paragraphs.push(title);length+=title.length;hasText=true;}
  for(const row of rows) {
    if(!Array.isArray(row))return;
    let line='';
    for(const node of row) {
      if(!node || typeof node!=='object' || ++nodes>1000)return;
      let text='';
      if(['text','md','code_block'].includes(node.tag) && typeof node.text==='string'){
        if(node.text.length>LIMIT)return;
        text=node.tag==='md'?markdownText(node.text,mentions):node.text;
        if(node.tag==='code_block'){
          const fence='`'.repeat(Math.max(3,...[...node.text.matchAll(/`+/g)].map(m=>m[0].length+1)));
          const language=typeof node.language==='string'?node.language.replace(/[^A-Za-z0-9_+-]/g,'').slice(0,30):'';
          text=`${fence}${language}\n${node.text}\n${fence}`;
        }
        hasText ||= !!text.trim();
      }else if(node.tag==='a'){
        const label=typeof node.text==='string'?node.text:'';const href=typeof node.href==='string'?node.href:'';
        text=label && label!==href?`[${label}]${href?`(${href})`:''}`:href;hasText ||= !!text.trim();
      }else if(node.tag==='at')text=mentionText(node.user_id,node.user_name,mentions);
      else if(node.tag==='hr')text='\n';
      else if(node.tag==='emotion' && typeof node.emoji_type==='string')text=`:${node.emoji_type}:`;
      else if(node.tag==='img')text='[图片附件未传入 Codex]';
      else if(node.tag==='media')text='[媒体附件未传入 Codex]';
      else return; // An unknown node may contain instructions; never execute a partial message.
      line+=text;length+=text.length;if(length+paragraphs.length>LIMIT)return;
    }
    paragraphs.push(line);
  }
  const result=paragraphs.join('\n');
  // A real @ without a question may still produce the existing local usage hint.
  return hasText || mentions.some(m=>result.includes(m.key))?result:undefined;
}
export function feishuText(message) {
  if(!['text','post'].includes(message?.message_type))return;
  const mentions=(Array.isArray(message.mentions)?message.mentions:[])
    .filter(m=>typeof m?.key==='string' && /^@_[A-Za-z0-9_]{1,80}$/.test(m.key));
  // Prefer the modern representation, but an absent/invalid v2 can use legacy text.
  for(const value of [message.content_v2,message.content]) {
    const body=decode(value);if(!body)continue;
    const text=message.message_type==='text'?body.text:postText(body,mentions);
    if(typeof text==='string' && text.trim() && text.length<=LIMIT)return text;
  }
}
