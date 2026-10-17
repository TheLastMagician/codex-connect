export const PAGE_SIZE=10;
export const HELP_HINT='发送 /help 查看所有操作。';
export const CHAT_NEXT='直接发消息即可继续这个会话。/read 查看对话，/status 查看状态；/chats 切换会话。';
export function statusLabel(value) {
  const status=typeof value==='object'?value?.type:value;
  return ({active:'执行中',inProgress:'执行中',idle:'就绪',notLoaded:'待机',needsAttention:'待你处理',
    completed:'已完成',failed:'执行失败',error:'发生错误',interrupted:'已中断'})[status]||'状态待确认';
}
export function projectName(session,thread) {
  return session.projects?.find(project=>project.projectId===thread.projectId)?.label || (thread.projectId?'所属项目见 /projects':'独立会话');
}
export function currentTarget(session) {
  return session.selected?`当前发送目标：${session.selected.title||session.selected.id}`:'当前还没选择会话。请用 /use 编号选择后再聊天。';
}
export function renderList(session) {
  const view=session.view;
  if(!view) throw new Error('请先发送 /chats 查看会话，或 /projects 查看项目，再翻页。');
  const entries=view.kind==='projects'?session.projects:session.threads;
  const page=view.page||1;const pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));
  const begin=(page-1)*PAGE_SIZE;
  const visible=entries.slice(begin,begin+PAGE_SIZE);
  const title=view.title || ({chats:'桌面会话',projects:'项目列表',archived:'已归档会话'})[view.kind];
  const more=view.kind==='archived' && !!session.archiveCursor;
  const count=more?`第 ${page} 页 · 已加载 ${entries.length} 个，后面还有`:`第 ${page}/${pages} 页 · 共 ${entries.length} 个`;
  const lines=[`${title}\n${count}`];
  if(!visible.length) lines.push(view.kind==='projects'?'没有可用项目。':'没有匹配的会话。');
  for(const [offset,entry] of visible.entries()) {
    const index=begin+offset+1;
    if(view.kind==='projects') lines.push(`${index}. ${entry.label}\n   ${entry.path||'远程项目'}`);
    else lines.push(`${index}. ${entry.title||'(无标题)'}${entry.pinnedIndex?' · 置顶':''}\n   ${projectName(session,entry)} · ${statusLabel(entry.status)}${entry.hostId && entry.hostId!=='local'?' · 远程':''}`);
  }
  const navigation=[];
  if(page>1) navigation.push('/prev 上一页');
  if(page<pages || more) navigation.push('/next 下一页');
  if(pages>1) navigation.push(`/page ${page===1?2:1} 跳页`);
  if(navigation.length) lines.push(`翻页：${navigation.join('；')}。编号跨页保持不变。`);
  else lines.push(view.partialNotice?'已显示当前可读取的结果。':'已显示全部结果，无需翻页。');
  if(visible.length) {
    const example=begin+1;
    if(view.kind==='projects') lines.push(`查看项目会话：/project ${example}，或直接回复 ${example}。\n在项目里新建：/new ${example} | 帮我检查项目`);
    else lines.push(`选择会话：/use ${example}，或直接回复 ${example}。${view.kind==='archived'?'选择后用 /unarchive 恢复，再聊天。':'选择后直接发任务。'}`);
  }
  if(view.kind==='chats') lines.push(view.projectId?'重新查看所有会话：/chats':'按标题查找：/chats 关键词；新建项目会话：/projects');
  if(view.partialNotice) lines.push(view.partialNotice);
  if(view.kind==='archived') lines.push('/chats 返回普通会话列表。');
  lines.push(currentTarget(session));
  if(view.unavailable) lines.push('部分远程主机暂不可用，恢复连接后用 /chats 刷新。');
  lines.push(HELP_HINT);
  return lines.join('\n\n');
}
