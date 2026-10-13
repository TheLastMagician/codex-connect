import {PAGE_SIZE,statusLabel,projectName} from './navigation.mjs';
import {modelSummary} from './models.mjs';
import {messageLabel} from './conversation.mjs';

const md=content=>({tag:'markdown',content});
const plain=content=>({tag:'plain_text',content:String(content)});
export function escapeLabel(value) {return String(value||'').replace(/[\\`*_\[\]<>]/g,char=>'\\'+char).replace(/[\r\n]+/g,' ');}
export function shortPath(value) {
  if(!value) return '远程项目';
  const parts=String(value).replace(/\\/g,'/').split('/').filter(Boolean);
  return parts.slice(-2).join(' / ');
}
function shell(title,subtitle,elements,color='blue') {
  return {schema:'2.0',config:{update_multi:true,summary:{content:title}},
    header:{title:plain(title),subtitle:plain(subtitle||'Codex · 本机桌面'),template:color},
    body:{direction:'vertical',padding:'16px 16px 12px 16px',elements}};
}
function button(label,action,issue,type='default') {
  return {tag:'button',text:plain(label),type,size:'medium',behaviors:[{type:'callback',value:{bridgeAction:issue(action)}}]};
}
function buttons(items,issue) {
  return {tag:'column_set',flex_mode:'flow',columns:items.map(({label,action,type})=>({tag:'column',width:'auto',elements:[button(label,action,issue,type)]}))};
}
function row(content,label,action,issue) {
  return {tag:'column_set',flex_mode:'none',columns:[
    {tag:'column',width:'weighted',weight:4,vertical_align:'center',elements:[md(content)]},
    {tag:'column',width:'auto',vertical_align:'center',elements:[button(label,action,issue)]}
  ]};
}
export function listCard(session,issue) {
  const view=session.view;const entries=view.kind==='projects'?session.projects:session.threads;
  const page=view.page||1;const pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));
  const start=(page-1)*PAGE_SIZE;const visible=entries.slice(start,start+PAGE_SIZE);
  const more=view.kind==='archived' && !!session.archiveCursor;
  const title=view.kind==='projects'?'项目':view.kind==='archived'?'已归档会话':view.projectId?view.title:'会话';
  const elements=[md(view.kind==='projects'?'选择项目，查看它的会话。':'选择会话，继续原来的工作。')];
  if(view.notice)elements.push(md(view.notice));
  if(!visible.length) elements.push(md('暂时没有匹配结果。可以刷新列表或换个关键词。'));
  for(const [offset,entry] of visible.entries()) {
    const index=start+offset+1;
    const content=view.kind==='projects'?`**${index}  ${escapeLabel(entry.label)}**\n${escapeLabel(shortPath(entry.path))}`:
      `**${index}  ${escapeLabel(entry.title||'未命名会话')}**\n${escapeLabel(projectName(session,entry))} · ${statusLabel(entry.status)}${entry.pinnedIndex?' · 置顶':''}`;
    const action=view.kind==='projects'?{kind:'project',project:entry}:{kind:'select',thread:entry};
    if(issue) elements.push(row(content,view.kind==='projects'?'查看':'选择',action,issue));
    else elements.push(md(content));
    if(offset<visible.length-1) elements.push({tag:'hr'});
  }
  elements.push({tag:'hr'});
  const actions=[];
  if(page>1) actions.push({label:'上一页',action:{kind:'page',viewId:view.id,page:page-1}});
  if(page<pages || more) actions.push({label:'下一页',type:'primary',action:{kind:'page',viewId:view.id,page:page+1}});
  actions.push({label:'项目',action:{kind:'command',command:'projects'}},{label:'会话',action:{kind:'command',command:'chats'}});
  const project=view.projectId && session.projects.find(p=>p.projectId===view.projectId);
  if(project) actions.push({label:'项目详情',action:{kind:'details',project}});
  if(issue) elements.push(buttons(actions,issue));
  elements.push(md(session.selected?`**当前会话**  ${escapeLabel(session.selected.title||'已选择会话')}`:'尚未选择会话'));
  const example=start+1;
  elements.push(md(view.kind==='projects'?`文字操作：\`/project ${example}\` 查看 · \`/projectinfo ${example}\` 详情 · \`/new ${example} | 任务内容\` 新建`:
    `文字操作：\`/use ${example}\` 选择${view.kind==='archived'?' · `/unarchive` 恢复':''}`));
  if(page<pages || more) elements.push(md('`/next` 下一页 · `/prev` 上一页 · `/help` 帮助'));
  if(view.unavailable) elements.push(md('部分远程主机暂不可用。'));
  if(view.partialNotice) elements.push(md(view.partialNotice));
  return shell(title,more?`第 ${page} 页 · 后面还有`:`第 ${page} / ${pages} 页 · ${entries.length} 项`,elements);
}
function formatCommands(text) {
  return String(text).replace(/(\/\w+)(?=\s|[，。；：、]|$)/g,'`$1`');
}
export function modelsCard(session,issue) {
  const selected=session.selected;const elements=[];
  if(selected)elements.push(md(`**${escapeLabel(selected.title||selected.id)}**\n${modelSummary(session)}`));
  else elements.push(md('先选择会话，再设置模型。'));
  for(const [index,model] of (session.models||[]).entries()) {
    const content=`**${index+1}  ${escapeLabel(model.id)}**\n推理强度：${model.efforts.join(' · ')}`;
    if(selected && issue)elements.push(row(content,'使用',{kind:'model',threadKey:`${selected.hostId||'local'}:${selected.id}`,model:model.id},issue));
    else elements.push(md(content));
    elements.push({tag:'hr'});
  }
  if(selected && issue)elements.push(buttons([{label:'沿用桌面设置',action:{kind:'model',model:'default',threadKey:`${selected.hostId||'local'}:${selected.id}`}},
    {label:'操作助手',action:{kind:'command',command:'assistant'}}],issue));
  elements.push(md('`/model 模型ID` 设置 · `/effort high` 推理强度\n设置按通道、账号、会话保存，仅影响后续手机任务。远程主机以实际支持为准。'));
  return shell('模型管理','Codex · 本机可用模型',elements);
}
export function replyCard(text,meta={},issue) {
  if(meta.kind==='list' && meta.session?.view) return listCard(meta.session,issue);
  if(meta.kind==='models' && meta.session)return modelsCard(meta.session,issue);
  const title=meta.title||({assistant:'Codex 回复',conversation:'最近对话',error:'操作未完成',help:'使用帮助'})[meta.kind]||'Codex';
  const color=meta.kind==='error'?'orange':['assistant','operator','conversation'].includes(meta.kind)?'turquoise':'blue';
  let content=String(text);
  if(meta.kind!=='assistant') content=formatCommands(content).replace(/\n发送 `\/help` 查看所有操作。\s*$/,'');
  const elements=[];
  if(meta.kind==='conversation' && meta.conversation) {
    if(meta.historyTruncated)elements.push(md('消息较多，已省略部分较早内容；完整上下文可在桌面查看。'),{tag:'hr'});
    const messages=meta.conversation.messages;
    if(!messages.length)elements.push(md('暂无可显示的对话消息。'));
    for(const [index,message] of messages.entries()) {
      if(index)elements.push({tag:'hr'});
      elements.push(md(`**${messageLabel(message,index)}**`),md(message.text));
    }
  }else elements.push(md(content));
  const session=meta.session;const selected=meta.thread||session?.selected;
  const options=[];
  if(selected) {
    elements.push({tag:'hr'});
    if(meta.kind==='assistant') elements.push(md(`**回复来自**  ${escapeLabel(selected.title||'桌面会话')}`));
    if(meta.kind==='conversation')elements.push(md(`**会话**  ${escapeLabel(selected.title||'桌面会话')}`));
    options.push({label:'选择此会话',type:'primary',action:{kind:'select',thread:selected}},
      {label:'进入直聊',action:{kind:'direct',thread:selected}});
    if(session?.selected?.id===selected.id) options.push({label:'查看对话',action:{kind:'command',command:'read',threadKey:`${selected.hostId||'local'}:${selected.id}`}},
      {label:'状态',action:{kind:'command',command:'status',threadKey:`${selected.hostId||'local'}:${selected.id}`}});
  }
  options.push({label:'会话列表',action:{kind:'command',command:'chats'}},{label:'项目',action:{kind:'command',command:'projects'}});
  if(selected)options.push({label:'模型',action:{kind:'command',command:'models',threadKey:`${selected.hostId||'local'}:${selected.id}`}});
  if(session?.mode==='chat')options.push({label:'返回操作助手',action:{kind:'command',command:'assistant'}});
  if(issue)for(let start=0;start<options.length;start+=4)elements.push(buttons(options.slice(start,start+4),issue));
  const subtitle=meta.kind==='conversation'?`${selected?.title||'当前会话'} · 最近 ${meta.conversation?.turnCount||0} 轮 · 从旧到新`:undefined;
  return shell(title,meta.subtitle||subtitle||'Codex · 本机桌面',elements,color);
}
export const CARD_TITLES={use:'已选中会话',new:'新会话已创建',send:'任务已发送',read:'最近对话',status:'当前会话',
  rename:'会话已重命名',pin:'已置顶',unpin:'已取消置顶',archive:'已归档',unarchive:'已恢复',fork:'已复制会话',
  open:'已在桌面打开',watch:'回复通知已开启',unwatch:'回复通知已关闭',help:'使用帮助',pair:'已配对',
  models:'模型管理',model:'模型设置',effort:'推理强度',assistant:'操作助手',resume:'已返回会话'};
