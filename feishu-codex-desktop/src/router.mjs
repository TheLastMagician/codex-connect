import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {clearLegacySessionData} from './legacy-cleanup.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {PAGE_SIZE,HELP_HINT,CHAT_NEXT,statusLabel,currentTarget,renderList} from './navigation.mjs';
import {CARD_TITLES} from './cards.mjs';
import {EFFORTS,threadKey,modelSettings,modelSummary,taskModelArgs,loadModels} from './models.mjs';
import {conversationMessages,renderConversation} from './conversation.mjs';
import {nativeTurnId,receiptEvidence,receiptCandidates,receiptHistoryComplete} from './receipt-evidence.mjs';

export const HELP = `Codex 桌面会话
继续已有会话：
1. /chats 查看列表
2. /use 1 选择会话，也可在列表后直接回复编号
3. 选中后直接发消息，就是与这个 Codex 会话聊天

列表每页 10 条：/next 下一页；/prev 上一页；/page 2 跳到第 2 页；/more 也可下一页。
/chats 关键词 — 按会话标题查找
/projects — 查看项目；/project 1 查看该项目会话
/new 1 | 帮我检查项目 — 在项目 1 新建会话
/new - | 帮我整理待办 — 新建独立会话
/read — 查看最近三轮对话，包含你的消息和 Codex 回复；/status — 查看当前发送目标和状态
/rename 新标题 — 重命名；/pin、/unpin — 置顶或取消置顶
/archive — 归档；/archived — 查看归档列表；/unarchive — 恢复所选会话
/fork — 复制并选中新会话；/open — 在本机桌面打开所选会话
/watch、/unwatch — 开启或关闭所选会话的回复通知
/send /开头的任务 — 将这类文字作为任务发送

/models — 查看桌面可用模型；/model — 查看当前覆盖设置
/model 模型ID（或编号）— 设置该会话的手机侧模型；/model default 恢复沿用桌面设置
/effort high — 设置推理强度；/effort default 恢复沿用桌面设置

默认沿用会话的模型、项目和上下文；模型覆盖按通道、账号和会话保存。桌面切换窗口不改变通道发送目标。
当前只支持文字。停止任务和执行审批需要在桌面处理。`;

export function parseMessage(event,{botOpenId,appId}={}) {
  const message = event?.message;
  const openId = event?.sender?.sender_id?.open_id;
  if(!openId || event.sender.sender_type !== 'user' || !['p2p','group'].includes(message?.chat_type) || message.message_type !== 'text') return null;
  if(appId && event.app_id && event.app_id!==appId)return null;
  if(!message.message_id || !message.chat_id || !message.create_time) return null;
  let text;try {text=JSON.parse(message.content).text;} catch{return null;}
  if(typeof text!=='string' || !text.trim() || text.length>12000) return null;
  const group=message.chat_type==='group';
  if(group) {
    if(!botOpenId || !Array.isArray(message.mentions))return null;
    const mentions=message.mentions.filter(m=>typeof m?.key==='string' && /^@_[A-Za-z0-9_]{1,80}$/.test(m.key));
    const own=mentions.filter(m=>m.id?.open_id===botOpenId);let addressed=false;
    for(const mention of own)text=text.replace(new RegExp(mention.key+'(?![A-Za-z0-9_])','g'),()=>{addressed=true;return '';});
    if(!addressed)return null;
    // Preserve other people mentioned in the task as readable user text.
    for(const mention of mentions.filter(m=>m.id?.open_id!==botOpenId && typeof m.name==='string'))
      text=text.replace(new RegExp(mention.key+'(?![A-Za-z0-9_])','g'),()=>'@'+mention.name);
  }
  return {openId,chatId:message.chat_id,id:message.message_id,text:text.trim(),timestamp:Number(message.create_time),
    ...(group?{chatType:'group',...(!text.trim()?{mentionOnly:true}:{})}:{})};
}
export function fingerprint(message) {return createHash('sha256').update(message.id).digest('hex');}
export function equalSecret(left,right) {
  const a=Buffer.from(String(left||''));const b=Buffer.from(String(right||''));
  return a.length===b.length && a.length>0 && timingSafeEqual(a,b);
}
export function renderThread(result,onlyStatus=false) {
  const thread=result.thread||{};
  const status=statusLabel(thread.status);
  const lines=[thread.title||thread.id||'当前会话',`状态：${status}`];
  if(!onlyStatus) lines.push(renderConversation(conversationMessages(result)));
  return lines.join('\n\n');
}
const keyOf = thread => `${thread.hostId||'local'}:${thread.id}`;
const threadArgs = thread => ({threadId:thread.id,...(thread.hostId?{hostId:thread.hostId}:{})});
export function threadSnapshot(result) {
  const turn=result.turns?.[0];
  const messages=(turn?.items||[]).filter(item=>item.type==='agentMessage' && item.text);
  const assistant=messages.findLast(item=>item.phase==='final_answer')||messages.at(-1);
  return {thread:result.thread,latestTurn:turn,latestAssistantMessage:assistant};
}
export class Router {
  constructor({desktop,getLocalThreads,getConfig,saveConfig,state,saveState,send,now=Date.now,channelLabel='飞书',isAuthorized,reportDeliveryFailure}) {
    Object.assign(this,{desktop,getLocalThreads,getConfig,saveConfig,state,saveState,send,now,channelLabel,isAuthorized,reportDeliveryFailure});
    this.state.sessions ||= {}; this.state.seen ||= {};
    this.watches = new Map(Object.entries(state.watches||{}));this.queues=new Map();this.pendingCounts=new Map();
    // A crash before an ACK cannot prove delivery. Recover from persisted
    // receipt evidence, never by replaying the task.
    for(const watch of this.watches.values())if(watch.receiptState==='submitting')watch.receiptState='uncertain';
    this.cardRequests=new Map();
    if(clearLegacySessionData(this.state))this.saveState();
  }
  authorized(openId) {return this.isAuthorized?this.isAuthorized(openId):this.getConfig().allowedOpenIds.includes(openId);}
  // Return immediately to the Feishu SDK: its event ACK deadline is three seconds.
  accept(event) {
    const message=parseMessage(event);
    return this.acceptMessage(message);
  }
  acceptMessage(message) {
    if(!message || !message.id || !message.openId || !message.chatId || typeof message.text!=='string' || !message.text.trim() || message.text.length>12000) return false;
    if(!message || !Number.isFinite(message.timestamp) || Math.abs(this.now()-message.timestamp)>10*60*1000) return false;
    const settings=this.getConfig();
    const pairing=message.text.match(/^\/pair\s+(\S+)$/);
    const canPair=message.chatType!=='group' && pairing && settings.pairing?.expiresAt>this.now() && equalSecret(pairing[1],settings.pairing.code);
    if(!this.authorized(message.openId) && !canPair) return false;
    const cardRequest=this.cardRequests.get(message.id);
    if(cardRequest) {message.cardAction=cardRequest.action;message.updateMessageId=cardRequest.updateMessageId;}
    const key=fingerprint(message);
    if(this.state.seen[key] || (this.pendingCounts.get(message.chatId)||0)>=20) return false;
    this.state.seen[key]=this.now();
    for(const [id,at] of Object.entries(this.state.seen)) if(this.now()-at>24*60*60*1000) delete this.state.seen[id];
    this.saveState(); // Persist before actions; duplicate delivery must not execute a task twice.
    this.pendingCounts.set(message.chatId,(this.pendingCounts.get(message.chatId)||0)+1);
    const previous=this.queues.get(message.chatId)||Promise.resolve();
    const work=previous.then(async()=>{
      // Recheck allowlist and pairing expiry after waiting in the queue.
      const latest=this.getConfig();
      if(!this.authorized(message.openId)) {
        if(!canPair || latest.pairing?.expiresAt<=this.now() || !equalSecret(pairing[1],latest.pairing?.code)) return;
        latest.allowedOpenIds=[...new Set([...latest.allowedOpenIds,message.openId])];
        delete latest.pairing; this.saveConfig(latest);
        return this.send(message.chatId,'配对成功。\n\n发送 /projects 或 /chats 查看列表。选中后直接发消息，就是与该 Codex 会话聊天。',{title:'已配对',openId:message.openId});
      }
      if(message.cardAction) await this.handleAction(message,message.cardAction);else await this.handle(message);
    }).catch(async error=>{
      if(error.code==='THREAD_NOT_SELECTED')this.noteDeliveryFailure('selection',error,this.session(message));
      try {await this.send(message.chatId,`${error.message}\n\n${currentTarget(this.session(message))}\n${HELP_HINT}`,
        {kind:'error',error,title:'操作未完成',session:this.session(message),openId:message.openId,updateMessageId:message.updateMessageId});}catch{/* Avoid unhandled retries and duplicate mutations. */}
    }).finally(()=>{
      this.cardRequests.delete(message.id);
      this.pendingCounts.set(message.chatId,(this.pendingCounts.get(message.chatId)||1)-1);
      if(this.queues.get(message.chatId)===work) this.queues.delete(message.chatId);
    });
    this.queues.set(message.chatId,work);return true;
  }
  acceptCard(context) {
    if(!this.authorized(context.openId)) return false;
    this.cardRequests.set(context.id,context);
    const accepted=this.accept({sender:{sender_type:'user',sender_id:{open_id:context.openId}},message:{
      message_id:context.id,chat_id:context.chatId,chat_type:'p2p',message_type:'text',create_time:String(this.now()),content:'{"text":"/_card"}'}});
    if(!accepted) this.cardRequests.delete(context.id);return accepted;
  }
  async handleAction(message,action) {
    const session=this.session(message);
    if(action.kind==='select' || action.kind==='direct') {
      const thread=action.thread;
      this.selectThread(session,thread);
      await this.send(message.chatId,`已选择：${thread.title||thread.id}\n\n${modelSummary(session)}\n\n${thread.archived?'先发送 /unarchive 恢复这个会话。':this.selectionHint(session)}\n/models 查看模型。`,
        {title:'已选中会话',command:'use',session,openId:message.openId,updateMessageId:message.updateMessageId});return;
    }
    if(action.kind==='project') {
      const output=await this.chats(session,'',action.project);
      await this.send(message.chatId,output,{kind:'list',session,openId:message.openId,updateMessageId:message.updateMessageId});return;
    }
    if(action.kind==='details') {
      await this.send(message.chatId,`**${action.project.label}**\n\n项目目录\n\`${action.project.path||'远程项目'}\``,
        {title:'项目详情',session,openId:message.openId,updateMessageId:message.updateMessageId});return;
    }
    if(action.kind==='page') {
      if(session.view?.id!==action.viewId) throw new Error('这份列表已经更新。请点击“会话列表”或发送 /chats 刷新。');
      return this.handle({...message,text:`/page ${action.page}`});
    }
    if(action.kind==='model') {
      if(!session.selected || keyOf(session.selected)!==action.threadKey)throw new Error('当前会话已切换，请重新打开 /models。');
      return this.handle({...message,text:`/model ${action.model}`});
    }
    const allowed=['chats','projects','archived','help','read','status','open','watch','unwatch','unarchive','models','model'];
    if(action.kind!=='command' || !allowed.includes(action.command)) throw new Error('按钮操作不受支持，请发送 /help。');
    if(action.threadKey && (!session.selected || keyOf(session.selected)!==action.threadKey)) throw new Error('当前会话已经切换。请先重新选择这个会话。');
    return this.handle({...message,text:`/${action.command}`});
  }
  session(message) {
    const key=`${message.openId}:${message.chatId}`;
    const session=this.state.sessions[key] ||= {openId:message.openId,chatId:message.chatId,threads:[],projects:[]};
    if(message.chatType==='group')session.chatType='group';
    return session;
  }
  selectThread(session,thread) {
    (session.knownThreads ||= {})[keyOf(thread)]=thread;
    session.selected=thread;session.awaitingChoice=null;this.saveState();
  }
  selectionHint() {return CHAT_NEXT;}
  async chats(session,query='',project) {
    const [result,projects]=await Promise.all([this.desktop.call('list_threads',{limit:50}),this.desktop.call('list_projects')]);
    session.projects=(projects.projects||[]).filter(p=>p.projectKind!=='chatgpt');
    if(project && !session.projects.some(p=>p.projectId===project.projectId)) throw new Error('这个项目已经不可用，请发送 /projects 刷新。');
    const recent=[...(result.pinnedThreads||[]),...(result.threads||[])];
    let historical=[];let catalogComplete=false;
    if(this.getLocalThreads) try {historical=await this.getLocalThreads(session.projects);catalogComplete=true;}catch{/* Show an explicit partial-list notice, preserving recent chats. */}
    const merged=new Map(historical.map(t=>[keyOf(t),t]));
    for(const t of recent) {
      const historical=merged.get(keyOf(t));
      merged.set(keyOf(t),{...historical,...t,projectId:t.projectId||historical?.projectId});
    }
    const threads=[...merged.values()].sort((a,b)=>{
      if(a.pinnedIndex || b.pinnedIndex) return (a.pinnedIndex||Infinity)-(b.pinnedIndex||Infinity);
      return (b.updatedAt||0)-(a.updatedAt||0);
    });
    session.knownThreads ||= {};
    for(const thread of threads) if(thread.kind==='codex') session.knownThreads[keyOf(thread)]=thread;
    session.threads=[...new Map(threads.filter(t=>t.kind==='codex' && (!project || t.projectId===project.projectId) && (!query || (t.title||'').toLowerCase().includes(query.toLowerCase()))).map(t=>[keyOf(t),t])).values()];
    const partialNotice=!catalogComplete?'历史列表暂时无法读取，目前仅显示最近 50 个加置顶会话。':
      project && project.hostId && project.hostId!=='local'?'远程主机目前仅能读取最近会话。':
      !project && session.projects.some(p=>p.hostId && p.hostId!=='local')?'本机会话已完整加载；远程主机目前仅显示最近会话。':undefined;
    session.view={id:randomUUID(),kind:'chats',page:1,title:project?`${project.label} · 会话`:query?`会话标题包含“${query}”`:'桌面会话',projectId:project?.projectId,unavailable:!!result.unavailableHosts?.length,catalogComplete,partialNotice};
    session.awaitingChoice='chat';
    this.saveState();
    return renderList(session);
  }
  choose(session,input) {
    if(/^\d+$/.test(input)) {
      const thread=session.threads[Number(input)-1]; if(thread) return thread;
    }
    const candidates=[...new Map([...session.threads,...Object.values(session.knownThreads||{}),...(session.selected?[session.selected]:[])].map(t=>[keyOf(t),t])).values()];
    const exact=candidates.filter(t=>t.id===input || t.title===input);
    if(exact.length===1) return exact[0];
    if(exact.length>1) throw new Error('标题重复，请使用会话编号');
    throw new Error('这个会话不在当前列表。发送 /chats 刷新，再用 /use 1 选择；也可以发送 /chats 标题关键词 查找。');
  }
  selected(session) {if(!session.selected) throw Object.assign(new Error('还没选择会话。发送 /projects 或 /chats 查看列表，用按钮或 /use 编号选择后直接聊天。'),{code:'THREAD_NOT_SELECTED'});return session.selected;}
  noteDeliveryFailure(stage,error,session,{retrying=false}={}) {
    const reason=error.code==='THREAD_NOT_SELECTED'?'no_selection':/授权/.test(error.message)?'authorization':
      /加载|打开目标/.test(error.message)?'not_loaded':/超时|timeout/i.test(error.message)?'timeout':
      /连接|connection|socket|pipe|ECONN|ENOENT|EPIPE|unavailable/i.test(error.message)||['DESKTOP_DISCONNECTED','ECONNRESET','ECONNREFUSED','EPIPE','ENOENT'].includes(error.code)?'connection':
      error.notSent?'not_sent':stage==='send'?'delivery_unknown':'read_failed';
    // Keep only bounded diagnostics, never user prompts, raw API errors or keys.
    const nativeReason=['request_timeout','start_timeout','connection_closed','router_rejected','native_error'].includes(error.nativeReason)?error.nativeReason:undefined;
    const record={at:this.now(),stage,reason,retrying,...(nativeReason?{nativeReason}:{}),...(session.selected?{threadId:session.selected.id,hostId:session.selected.hostId||'local'}:{})};
    this.state.deliveryFailures=[...(this.state.deliveryFailures||[]),record].slice(-20);this.saveState();this.reportDeliveryFailure?.(record);
  }
  async readBeforeSend(session,authorize) {
    const selected=this.selected(session);
    for(let attempt=0;attempt<2;attempt++) {
      authorize();
      try {
        const result=await this.desktop.call('read_thread',{...threadArgs(selected),turnLimit:1,maxOutputCharsPerItem:20000},{beforeSend:authorize});
        return {...threadSnapshot(result),turns:result.turns||[]};
      }
      catch(error) {
        authorize();
        const transient=['DESKTOP_DISCONNECTED','ECONNRESET','ECONNREFUSED','EPIPE','ENOENT','ETIMEDOUT'].includes(error.code) ||
          /连接|超时|connection|socket|ECONN|ENOENT|EPIPE|timeout|unavailable|Codex app tool request failed/i.test(error.message);
        const retrying=attempt===0 && transient;this.noteDeliveryFailure('read',error,session,{retrying});
        if(!retrying)throw Object.assign(new Error('已保留所选会话，但发送前连接检查失败，这条消息尚未发送。稍后可直接重发，无需重新选择会话。'),{notSent:true});
        // Retrying this read can reconnect an idle transport. The task has not
        // been submitted; never retry an actual send with an unknown outcome.
        await delay(250);
      }
    }
  }
  async archived(session,reset=false) {
    const cursor=reset?undefined:session.archiveCursor;
    const result=await this.desktop.call('list_archived_threads',{source:'codex',hostId:'local',limit:PAGE_SIZE,...(cursor?{cursor}:{})});
    const entries=(result.threads||[]).filter(t=>t.kind==='codex').map(t=>({...t,hostId:t.hostId||'local',archived:true}));
    if(reset) {session.threads=[];session.view={id:randomUUID(),kind:'archived',page:1};session.archiveCursors=[];}
    if(cursor) {
      if(session.archiveCursors?.includes(cursor)) throw new Error('归档列表翻页信息已失效，请发送 /archived 刷新。');
      (session.archiveCursors ||= []).push(cursor);
    }
    const seen=new Set(session.threads.map(keyOf));
    session.threads.push(...entries.filter(t=>!seen.has(keyOf(t))));
    session.knownThreads ||= {};for(const thread of entries) session.knownThreads[keyOf(thread)]=thread;
    session.archiveCursor=result.nextCursor||null;session.awaitingChoice='chat';this.saveState();
  }
  async page(session,direction,arg='') {
    const view=session.view;
    if(!view) throw new Error('请先发送 /chats、/projects 或 /archived 打开一个列表，再翻页。');
    const current=view.page||1;
    if(direction==='page' && (!/^\d+$/.test(arg) || Number(arg)<1)) throw new Error('跳页示例：/page 2。也可以用 /next 下一页、/prev 上一页。');
    const wanted=direction==='next'?current+1:direction==='prev'?current-1:Number(arg);
    const entries=view.kind==='projects'?session.projects:session.threads;
    let pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));
    let note='';
    if(wanted<1) note='已经是第一页。';
    else if(wanted>pages && view.kind==='archived' && session.archiveCursor) {
      if(wanted>pages+1) note=`归档列表还没有加载第 ${wanted} 页。用 /next 逐页加载后，可用 /page 编号 来回跳页。`;
      else {await this.archived(session);pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));if(wanted>pages) note='已经到最后一页。';}
    } else if(wanted>pages) note=`已经到最后一页，共 ${pages} 页。`;
    if(!note) view.page=wanted;
    view.notice=note||null;
    session.awaitingChoice=view.kind==='projects'?'project':'chat';this.saveState();
    return (note?note+'\n\n':'')+renderList(session);
  }
  async handle(message) {
    const session=this.session(message);
    const authorize=()=>{if(!this.authorized(message.openId))throw new Error('通道授权已撤销，未执行该操作');};
    const choice=message.text.match(/^选择\s*(\d+)$/);const page=message.text.match(/^第?\s*(\d+)\s*页$/);
    if(choice)message={...message,text:`/use ${choice[1]}`};
    else if(page)message={...message,text:`/page ${page[1]}`};
    else if(['项目列表','会话列表','切换会话','帮助'].includes(message.text))message={...message,text:({'项目列表':'/projects','会话列表':'/chats','切换会话':'/chats','帮助':'/help'})[message.text]};
    const match=message.text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    let command=match?.[1].toLowerCase();let arg=match?.[2]?.trim()||'';
    if(!command && session.view && ['下一页','上一页'].includes(message.text)) command=message.text==='下一页'?'next':'prev';
    if(!command && session.awaitingChoice && /^\d+$/.test(message.text)) {command=session.awaitingChoice==='project'?'project':'use';arg=message.text;}
    let output;let threadStatus;let conversation;let receiptStatus;
    switch(command) {
      case 'help': output=HELP+'\n\n'+currentTarget(session);break;
      case 'models': {
        const models=await loadModels(this.desktop,session);this.saveState();
        output='本机 Codex 可用模型\n\n'+models.map((m,i)=>`${i+1}｜${m.id}\n推理强度：${m.efforts.join('、')}`).join('\n\n')+
          `\n\n${session.selected?modelSummary(session)+'\n/model 1 或 /model 模型ID 设置；/model default 取消覆盖。':'先 /chats 选择会话，再 /model 模型ID。'}\n/effort high 设置强度。远程主机以实际支持为准。`;break;
      }
      case 'model':case 'effort': {
        const selected=this.selected(session);const key=threadKey(selected);
        if(!arg){output=`${selected.title||selected.id}\n\n${modelSummary(session)}\n\n/models 查看模型；/model 模型ID 设置；/effort high 设置强度。`;break;}
        const settings={...modelSettings(session)};
        if(arg==='default') {
          if(command==='model'){delete settings.model;delete settings.thinking;}else delete settings.thinking;
        }else if(command==='model') {
          const models=await loadModels(this.desktop,session);
          const model=/^\d+$/.test(arg)?models[Number(arg)-1]:models.find(m=>m.id===arg);
          if(!model)throw new Error('模型不在本机可用目录中。先发送 /models 查看，未改变原设置。');
          if(settings.thinking && !model.efforts.includes(settings.thinking))throw new Error(`该模型不支持已指定的 ${settings.thinking} 强度。先 /effort default，再选择模型。`);
          settings.model=model.id;
        }else {
          if(!EFFORTS.includes(arg))throw new Error('推理强度无效。可用：'+EFFORTS.join('、')+'；或 default。');
          if(settings.model) {
            const models=await loadModels(this.desktop,session);const model=models.find(m=>m.id===settings.model);
            if(!model || !model.efforts.includes(arg))throw new Error(`当前模型不支持该强度。可用：${model?.efforts.join('、')||'请重新 /models 查看'}。`);
          }
          settings.thinking=arg;
        }
        authorize();(session.modelOverrides ||= {})[key]=settings;this.saveState();
        output=`已更新：${selected.title||selected.id}\n\n${modelSummary(session)}\n\n只对当前通道发给此会话的后续任务生效，不启动任务。/model default 恢复沿用桌面设置。`;
        break;
      }
      case 'pair':output='已配对，无需重复配对。/chats 查看列表，选中后直接发消息。\n'+HELP_HINT;break;
      case 'chats':output=await this.chats(session,arg);break;
      case 'next':case 'more':output=await this.page(session,'next');break;
      case 'prev':output=await this.page(session,'prev');break;
      case 'page':output=await this.page(session,'page',arg);break;
      case 'use': {
        if(!arg) throw new Error('选择示例：/use 1。先发送 /chats 可查看编号；在会话列表后也可以直接回复 1。');
        if(session.view?.kind==='projects' && /^\d+$/.test(arg)) throw new Error(`你看到的是项目编号。发送 /project ${arg} 查看该项目会话，或 /new ${arg} | 任务内容 新建会话。`);
        this.selectThread(session,this.choose(session,arg));
        output=`已选择：${session.selected.title||session.selected.id}\n项目和上下文保持当前设置。\n\n${modelSummary(session)}\n\n${session.selected.archived?'这个会话已归档。先发送 /unarchive 恢复。':this.selectionHint(session)}\n/models 管理模型。\n${HELP_HINT}`;break;
      }
      case 'projects': {
        const result=await this.desktop.call('list_projects');
        session.projects=(result.projects||[]).filter(p=>p.projectKind!=='chatgpt');session.view={id:randomUUID(),kind:'projects',page:1};session.awaitingChoice='project';this.saveState();
        output=renderList(session);break;
      }
      case 'project': {
        const project=/^\d+$/.test(arg)?session.projects[Number(arg)-1]:session.projects.find(p=>p.label===arg);
        if(!project) throw new Error('先发送 /projects 查看项目编号，再发送 /project 1 查看该项目的会话。');
        output=await this.chats(session,'',project);
        output+=`\n\n想在这个项目新建会话：/new ${session.projects.findIndex(p=>p.projectId===project.projectId)+1} | 帮我检查项目`;break;
      }
      case 'projectinfo': {
        const project=session.projects[Number(arg)-1];
        if(!/^\d+$/.test(arg) || !project) throw new Error('先发送 /projects 查看项目，再用 /projectinfo 1 查看完整目录。');
        output=`**${project.label}**\n\n项目目录\n\`${project.path||'远程项目'}\`\n\n/project ${arg} 查看会话，/new ${arg} | 任务内容 新建会话。`;break;
      }
      case 'new': {
        const split=arg.indexOf('|');if(split<0) throw new Error('新建项目会话：先 /projects，再 /new 1 | 帮我检查项目。\n不选项目：/new - | 帮我整理待办');
        const project=arg.slice(0,split).trim();const prompt=arg.slice(split+1).trim();
        if(!prompt) throw new Error('请在 | 后写任务。例如：/new 1 | 检查项目能否启动');
        let target;
        if(project==='-') target={type:'projectless'};
        else {
          const entry=session.projects[Number(project)-1];
          if(!/^\d+$/.test(project) || !entry) throw new Error('项目编号无效。先发送 /projects，再用列表里的编号：/new 1 | 帮我检查项目');
          target={type:'project',projectId:entry.projectId,environment:{type:'local'}};
        }
        authorize();const result=await this.desktop.call('create_thread',{prompt,target},{beforeSend:authorize});
        if(!result.threadId) throw new Error('桌面没有返回已就绪会话 ID，请用 /chats 查看创建结果，不要重复创建');
        this.selectThread(session,{id:result.threadId,hostId:result.hostId||'local',title:result.title||result.threadId,kind:'codex'});
        this.watch(session);
        output=`已创建并选中桌面会话：${session.selected.title}\n任务已开始，回复会自动发回${this.channelLabel}。\n\n${CHAT_NEXT}\n${HELP_HINT}`;break;
      }
      case 'read':case 'status': {
        const selected=this.selected(session);
        const result=await this.desktop.call('read_thread',{...threadArgs(selected),turnLimit:command==='read'?3:1,includeOutputs:command==='read',maxOutputCharsPerItem:4000});
        threadStatus=result.thread?.status;
        if(command==='read') conversation={messages:conversationMessages(result),turnCount:result.turns?.length||0};
        output=renderThread(result,command==='status')+(command==='status'?`\n\n${modelSummary(session)}`:'')+`\n\n${selected.archived?'会话已归档，先 /unarchive 恢复再聊天。':this.selectionHint(session)}\n${HELP_HINT}`;break;
      }
      case 'rename': {
        if(!arg || arg.length>200) throw new Error('请输入 1–200 字符的标题。例如：/rename 修复启动错误');
        const selected=this.selected(session);
        await this.desktop.call('set_thread_title',{threadId:selected.id,source:'codex',title:arg});
        selected.title=arg;this.saveState();output=`已重命名为：${arg}\n\n${this.selectionHint(session)}`;break;
      }
      case 'pin':case 'unpin': {
        await this.desktop.call('move_thread_to_sidebar_section',{...threadArgs(this.selected(session)),sectionId:command==='pin'?'pinned':null,source:'codex'});
        output=`${this.selected(session).title||this.selected(session).id}\n${command==='pin'?'已置顶。发送 /unpin 可以取消。':'已取消置顶。发送 /pin 可以重新置顶。'}\n\n${this.selectionHint(session)}`;break;
      }
      case 'archive':case 'unarchive': {
        const selected=this.selected(session);
        await this.desktop.call('set_thread_archived',{...threadArgs(selected),archived:command==='archive',source:'codex'});
        selected.archived=command==='archive';this.saveState();this.unwatch(session);
        output=`${selected.title||selected.id}\n${command==='archive'?'已归档。/unarchive 可以恢复；/chats 可以选择其他会话。':'已恢复。直接发消息即可继续聊天。'}`;break;
      }
      case 'archived': {
        await this.archived(session,true);output=renderList(session);break;
      }
      case 'fork': {
        const selected=this.selected(session);
        if(selected.hostId && selected.hostId!=='local') throw new Error('当前接口不支持直接 fork 远程会话');
        const result=await this.desktop.call('fork_thread',{threadId:selected.id});
        if(!result.threadId) throw new Error('未返回已就绪会话 ID，请 /chats 查看结果');
        this.selectThread(session,{id:result.threadId,hostId:result.hostId||'local',title:result.title||result.threadId,kind:'codex'});
        output=`已复制并选中新会话：${session.selected.title}\n\n${this.selectionHint(session)}`;break;
      }
      case 'open': {
        await this.desktop.call('navigate_to_codex_page',{threadId:this.selected(session).id});output=`已在本机桌面打开：${this.selected(session).title||this.selected(session).id}\n${currentTarget(session)}`;break;
      }
      case 'watch':this.watch(session,threadSnapshot(await this.desktop.call('read_thread',{...threadArgs(this.selected(session)),turnLimit:1,maxOutputCharsPerItem:20000})));output=`已开启回复通知：${this.selected(session).title||this.selected(session).id}\n后续回复会自动发回${this.channelLabel}；/unwatch 关闭，/status 查看状态。`;break;
      case 'unwatch':this.selected(session);this.unwatch(session);output=`已关闭回复通知：${this.selected(session).title||this.selected(session).id}\n会话继续运行。/watch 重新开启，/read 随时查看对话。`;break;
      case 'stop':case 'approve':case 'reject':
        output=`这个版本不能在${this.channelLabel}停止任务或批准执行。请在 Codex 桌面处理。\n/status 查看当前会话；/open 在本机打开它。`;break;
      case 'send':default: {
        if(command && command!=='send') throw new Error('没有这个指令。发送 /help 查看操作；如果这是一条以 / 开头的任务，请发送 /send 加原任务内容。');
        const prompt=command==='send'?arg:message.text;
        if(!prompt) throw new Error('请写上任务内容。例如：/send 帮我检查构建错误');
        const selected=this.selected(session);
        if(selected.archived) throw new Error('当前会话已归档。先发送 /unarchive 恢复，再直接聊天；或 /chats 选择其他会话。');
        const baseline=await this.readBeforeSend(session,authorize);
        // This text is an authenticated user's explicit instruction to this selected chat.
        authorize();
        const clientUserMessageId=randomUUID(),receiptKey=`receipt:${clientUserMessageId}`;
        if([...this.watches.values()].filter(w=>w.receiptState).length>=100)throw new Error('待核对消息过多，这条消息尚未发送。请先查看已有会话结果。');
        const receipt={openId:session.openId,chatId:session.chatId,thread:{...selected},clientUserMessageId,receiptState:'submitting',createdAt:this.now(),
          evidence:receiptEvidence(prompt,baseline.turns)};
        this.watches.set(receiptKey,receipt);this.persistWatches();
        try {
          const ack=await this.desktop.call('send_message_to_thread',{...threadArgs(selected),prompt,...taskModelArgs(session),clientUserMessageId},{beforeSend:authorize,
            onLoading:async()=>{
              authorize();
              await this.send(message.chatId,`正在打开并加载 ${selected.title||selected.id}，最多等待 2 分钟。\n本条消息尚未发送；加载就绪后会自动发送，无需重复提交。`,
                {kind:'info',title:'会话加载中',thread:{...selected},session,openId:message.openId});
            },
            beforeSubmit:()=>{authorize();receipt.submittedAt=this.now();this.persistWatches();}});
          if(ack?.turnId)this.claimReceiptTurn(receipt,ack.turnId);
        }catch(error) {
          this.noteDeliveryFailure('send',error,session);
          if(error.notSent){this.watches.delete(receiptKey);this.persistWatches();throw error;}
          receipt.receiptState='uncertain';this.persistWatches();
          try {await this.checkReceipt(receipt);}catch{/* Only retry reads in background; never repeat the write. */}
          receiptStatus=receipt.receiptState;
          output=receipt.receiptState==='confirmed'
            ?`已核对：这条消息已进入 ${selected.title||selected.id}。\n回复会自动发回${this.channelLabel}，无需重发。`
            :`发送回执暂未确认，正在自动核对消息是否进入 ${selected.title||selected.id}。\n请暂时不要重复发送；确认后会自动通知并继续返回回复。`;
          receipt.confirmationNotified=receipt.receiptState==='confirmed';this.persistWatches();
          break;
        }
        this.watches.delete(receiptKey);session.awaitingChoice=null;this.watch(session,baseline);output=`已发送到：${selected.title||selected.id}\n回复会自动发回${this.channelLabel}。\n/status 查看进度，/read 查看对话，/chats 切换会话。`;
      }
    }
    const listCommands=['chats','projects','project','archived','next','prev','page','more'];
    const meta={kind:listCommands.includes(command)?'list':command==='models'?'models':command==='read'?'conversation':command==='help'?'help':'info',
      title:receiptStatus==='uncertain'?'发送核对中':receiptStatus==='confirmed'?'发送已确认':CARD_TITLES[command||'send']||(command==='projectinfo'?'项目详情':'Codex'),session,openId:message.openId,updateMessageId:message.updateMessageId,
      command:command||'send',threadStatus,conversation};
    await this.send(message.chatId,output,meta);
  }
  watch(session,baseline) {
    const thread=this.selected(session); const key=`${session.openId}:${session.chatId}:${keyOf(thread)}`;
    (session.knownThreads ||= {})[keyOf(thread)]=thread;
    this.watches.set(key,{openId:session.openId,chatId:session.chatId,thread:{...thread},
      messageId:baseline?.latestAssistantMessage?.id,baselineTurnId:baseline?.latestTurn?.id});
    this.persistWatches();
  }
  persistWatches() {this.state.watches=Object.fromEntries(this.watches);this.saveState();}
  unwatch(session) {
    const selected=session.selected;
    for(const [key,watch] of this.watches) if(watch.openId===session.openId && watch.chatId===session.chatId && (!selected || keyOf(watch.thread)===keyOf(selected))) this.watches.delete(key);
    this.persistWatches();
  }
  async checkReceipt(watch,reads) {
    if(!this.authorized(watch.openId))return;
    const turns=[];let cursor;const cursors=new Set();let complete=false;
    for(let page=0;page<10;page++) {
      const key=JSON.stringify([keyOf(watch.thread),cursor||null]);
      let request=reads?.get(key);
      if(!request){request=this.desktop.call('read_thread',{...threadArgs(watch.thread),turnLimit:10,maxOutputCharsPerItem:20000,...(cursor?{cursor}:{})},{timeoutMs:20000});reads?.set(key,request);}
      const result=await request;
      if(!this.authorized(watch.openId))return;
      for(const turn of result.turns||[])if(!turns.some(t=>t.id===turn.id))turns.push(turn);
      const matched=receiptCandidates(turns,watch);
      complete=receiptHistoryComplete(result,watch);
      if((matched.method!=='evidence' && matched.turns.length===1) || complete)break;
      cursor=result.page?.nextCursor;
      if(!cursor || cursors.has(cursor))break;
      cursors.add(cursor);
    }
    const matched=receiptCandidates(turns,watch);let turn;
    if(matched.turns.length===1 && (matched.method!=='evidence' || complete)) {
      const candidate=matched.turns[0];
      const claimed=this.state.receiptTurnClaims?.[this.receiptTurnKey(watch,candidate.id)];
      const competing=matched.method==='evidence' && [...this.watches.values()].some(other=>other!==watch && other.receiptState &&
        keyOf(other.thread)===keyOf(watch.thread) && other.clientUserMessageId!==watch.clientUserMessageId && receiptCandidates([candidate],other).turns.length);
      if(!competing && (!claimed || claimed===watch.clientUserMessageId))turn=candidate;
    }
    if(turn){watch.receiptState='confirmed';watch.confirmedTurnId=turn.id;this.claimReceiptTurn(watch,turn.id);this.persistWatches();}
    return {turn};
  }
  receiptTurnKey(watch,turnId) {return fingerprint({id:JSON.stringify([keyOf(watch.thread),turnId])});}
  claimReceiptTurn(watch,turnId) {
    if(!nativeTurnId(turnId))return;
    const claims=this.state.receiptTurnClaims ||= {};
    claims[this.receiptTurnKey(watch,turnId)]=watch.clientUserMessageId;
    this.state.receiptTurnClaims=Object.fromEntries(Object.entries(claims).slice(-1000));this.saveState();
  }
  async sendWatchedReply(watch,text,assistantId,kind='assistant') {
    const mark=fingerprint({id:JSON.stringify([watch.openId,watch.chatId,keyOf(watch.thread),assistantId])});
    const marks=this.state.deliveredReplyMarks ||= {};
    if(marks[mark])return;
    if(!this.authorized(watch.openId))return;
    await this.send(watch.chatId,text,{kind,title:kind==='assistant'?'Codex 回复':'会话状态',thread:watch.thread,openId:watch.openId,
      session:this.state.sessions[`${watch.openId}:${watch.chatId}`]});
    marks[mark]=this.now();this.state.deliveredReplyMarks=Object.fromEntries(Object.entries(marks).slice(-200));this.saveState();
  }
  async pollReceipt(key,watch,reads) {
    if(watch.receiptState==='submitting')return;
    const checked=await this.checkReceipt(watch,reads);
    if(this.watches.get(key)!==watch || !this.authorized(watch.openId))return;
    const turn=checked?.turn;if(!turn)return;
    const terminal=['completed','failed','interrupted'].includes(turn.status);
    if(!watch.confirmationNotified && !terminal) {
      await this.send(watch.chatId,`已确认：消息已进入 ${watch.thread.title||watch.thread.id}，无需重发。回复会自动返回。`,
        {kind:'info',title:'发送已确认',thread:watch.thread,openId:watch.openId,session:this.state.sessions[`${watch.openId}:${watch.chatId}`]});
      watch.confirmationNotified=true;this.persistWatches();
    }
    if(!terminal)return;
    const assistant=threadSnapshot({turns:[turn]}).latestAssistantMessage;
    await this.sendWatchedReply(watch,turn.status==='completed'?(assistant?.text||'任务已完成，没有文字回复。'):
      `已确认消息进入会话，但这次任务${turn.status==='failed'?'执行失败':'已中断'}。请 /read 查看详情。`,assistant?.id||turn.id,turn.status==='completed'?'assistant':'info');
    if(this.watches.get(key)===watch)this.watches.delete(key);this.persistWatches();
  }
  async poll() {
    const receiptReads=new Map();
    for(const [key,watch] of [...this.watches]) {
      if(!this.authorized(watch.openId)) {this.watches.delete(key);continue;}
      if(watch.receiptState) {try{await this.pollReceipt(key,watch,receiptReads);}catch{/* Retain receipt evidence across read/notification failures; never replay input. */}continue;}
      try {
        const snapshot=threadSnapshot(await this.desktop.call('read_thread',{...threadArgs(watch.thread),turnLimit:1,maxOutputCharsPerItem:20000}));
        if(this.watches.get(key)!==watch || !this.authorized(watch.openId))continue;
        const assistant=snapshot.latestAssistantMessage;
        if(snapshot.latestTurn?.status==='completed' && assistant?.text && assistant.id!==watch.messageId) {
          await this.sendWatchedReply(watch,assistant.text,assistant.id);
          watch.messageId=assistant.id;
        }
        const status=snapshot.thread?.status?.type;
        if(status==='needsAttention' && !watch.attentionNotified) {await this.send(watch.chatId,`${watch.thread.title||watch.thread.id}\n需要你在 Codex 桌面处理审批或输入。\n/use ${watch.thread.id} 选中该会话，再 /open 在本机打开。`);watch.attentionNotified=true;}
        if(status!=='needsAttention') watch.attentionNotified=false;
        if(['completed','failed','interrupted'].includes(snapshot.latestTurn?.status) && snapshot.latestTurn?.id!==watch.baselineTurnId) {
          if(snapshot.latestTurn.status!=='completed') await this.send(watch.chatId,`会话${snapshot.latestTurn.status==='failed'?'执行失败':'已中断'}。请 /read 查看结果。`);
          if(this.watches.get(key)===watch)this.watches.delete(key);
        }
      } catch(error) {
        if(this.watches.get(key)!==watch)continue;
        await this.send(watch.chatId,`会话通知暂停：${error.message}`).catch(()=>{});if(this.watches.get(key)===watch)this.watches.delete(key);
      }
    }
    this.persistWatches();
  }
}
