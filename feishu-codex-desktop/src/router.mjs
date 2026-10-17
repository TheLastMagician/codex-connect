import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PAGE_SIZE,HELP_HINT,CHAT_NEXT,statusLabel,currentTarget,renderList} from './navigation.mjs';
import {CARD_TITLES} from './cards.mjs';
import {EFFORTS,threadKey,modelSettings,modelSummary,taskModelArgs,loadModels} from './models.mjs';
import {conversationMessages,renderConversation} from './conversation.mjs';

export const HELP = `Codex 桌面会话
继续已有会话：
1. /chats 查看列表
2. /use 1 选择会话，也可在列表后直接回复编号
3. 选中后直接发消息，就是与这个 Codex 会话聊天
4. /assistant 打开操作助手，帮你查找、切换或管理会话

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
/assistant — 打开操作助手；未选择会话时，普通消息也会交给助手

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
  constructor({desktop,getLocalThreads,getConfig,saveConfig,state,saveState,send,now=Date.now,channelLabel='飞书',operator,isAuthorized,reportDeliveryFailure}) {
    Object.assign(this,{desktop,getLocalThreads,getConfig,saveConfig,state,saveState,send,now,channelLabel,operator,isAuthorized,reportDeliveryFailure});
    this.state.sessions ||= {}; this.state.seen ||= {};
    this.watches = new Map(Object.entries(state.watches||{}));this.queues=new Map();this.pendingCounts=new Map();
    this.cardRequests=new Map();
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
        return this.send(message.chatId,'配对成功。\n\n可让操作助手查找会话，或 /chats 查看列表。选中后直接发消息，就是与该 Codex 会话聊天。\n/assistant 打开操作助手。',{title:'已配对',openId:message.openId});
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
    const allowed=['chats','projects','archived','help','read','status','open','watch','unwatch','unarchive','models','model','assistant','resume'];
    if(action.kind!=='command' || !allowed.includes(action.command)) throw new Error('按钮操作不受支持，请发送 /help。');
    if(action.threadKey && (!session.selected || keyOf(session.selected)!==action.threadKey)) throw new Error('当前会话已经切换。请先重新选择这个会话。');
    return this.handle({...message,text:`/${action.command}`});
  }
  session(message) {
    const key=`${message.openId}:${message.chatId}`;
    const session=this.state.sessions[key] ||= {openId:message.openId,chatId:message.chatId,threads:[],projects:[]};
    if(message.chatType==='group')session.chatType='group';
    // Existing selections now receive ordinary messages immediately. Explicit
    // assistant choices made after this migration still survive restarts.
    if(session.routingVersion!==3) {
      session.mode=session.selected?'chat':this.operator?'assistant':'chat';session.routingVersion=3;this.saveState();
    }
    return session;
  }
  selectThread(session,thread) {
    (session.knownThreads ||= {})[keyOf(thread)]=thread;
    session.selected=thread;session.mode='chat';session.awaitingChoice=null;this.saveState();
  }
  selectionHint(session) {return session.mode==='chat'?CHAT_NEXT:'当前是操作助手。/chats 选择会话后直接聊天。/read 查看对话，/status 查看状态。';}
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
  selected(session) {if(!session.selected) throw Object.assign(new Error('还没选择会话。直接让助手找会话，或 /chats 后用 /use 1 选择；选中后直接发消息即可。'),{code:'THREAD_NOT_SELECTED'});return session.selected;}
  noteDeliveryFailure(stage,error,session,{retrying=false}={}) {
    const reason=error.code==='THREAD_NOT_SELECTED'?'no_selection':/授权/.test(error.message)?'authorization':
      /加载|打开目标/.test(error.message)?'not_loaded':/超时|timeout/i.test(error.message)?'timeout':
      /连接|connection|socket|pipe|ECONN|ENOENT|EPIPE|unavailable/i.test(error.message)||['DESKTOP_DISCONNECTED','ECONNRESET','ECONNREFUSED','EPIPE','ENOENT'].includes(error.code)?'connection':
      error.notSent?'not_sent':stage==='send'?'delivery_unknown':'read_failed';
    // Keep only bounded diagnostics, never user prompts, raw API errors or keys.
    const record={at:this.now(),stage,reason,retrying,...(session.selected?{threadId:session.selected.id,hostId:session.selected.hostId||'local'}:{})};
    this.state.deliveryFailures=[...(this.state.deliveryFailures||[]),record].slice(-20);this.saveState();this.reportDeliveryFailure?.(record);
  }
  async readBeforeSend(session,authorize) {
    const selected=this.selected(session);
    for(let attempt=0;attempt<2;attempt++) {
      authorize();
      try {return threadSnapshot(await this.desktop.call('read_thread',{...threadArgs(selected),turnLimit:1,maxOutputCharsPerItem:20000},{beforeSend:authorize}));}
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
  async askAssistant(message) {
    const session=this.session(message);
    if(!this.operator)throw new Error('操作助手未配置。先用 /projects 或 /chats 选择会话。');
    const context={mode:session.mode,selected:session.selected?{id:session.selected.id,title:session.selected.title,hostId:session.selected.hostId}:null,
      projects:session.projects.slice(0,60).map(p=>({projectId:p.projectId,label:p.label})),
      chats:session.threads.slice(0,40).map(t=>({id:t.id,title:t.title,hostId:t.hostId})),model: modelSettings(session)};
    const capture=text=>this.handle({...message,text},{capture:true});
    const result=await this.operator.respond({text:message.text,session,context,
      authorize:()=>this.authorized(message.openId),
      execute:async(name,args)=>{
        if(name==='list_projects') {
          const reply=await capture('/projects');
          return {reply,result:{projects:session.projects.map(p=>({projectId:p.projectId,label:p.label}))}};
        }
        if(name==='find_chats') {
          // Refresh project identities before accepting an AI-provided project ID.
          const projects=await this.desktop.call('list_projects');
          session.projects=(projects.projects||[]).filter(p=>p.projectKind!=='chatgpt');
          const project=args.projectId?session.projects.find(p=>p.projectId===args.projectId):undefined;
          if(args.projectId && !project)throw new Error('项目 ID 不在真实项目目录中');
          const output=await this.chats(session,args.query||'',project);
          return {reply:{output,meta:{kind:'list',session,openId:message.openId}},result:{total:session.threads.length,
            chats:session.threads.slice(0,60).map(t=>({threadId:t.id,title:t.title,hostId:t.hostId||'local'})),truncated:session.threads.length>60}};
        }
        if(name==='select_chat') {
          const matches=[...new Map([...session.threads,...Object.values(session.knownThreads||{})].map(t=>[keyOf(t),t])).values()].filter(t=>t.id===args.threadId && (!args.hostId || (t.hostId||'local')===args.hostId));
          if(matches.length!==1)throw new Error('会话 ID 未查询到或目标不唯一，请重新查找');
          this.selectThread(session,matches[0]);
          return {result:{selected:args.threadId},reply:{output:`已选择：${session.selected.title||session.selected.id}\n\n${modelSummary(session)}\n\n${session.selected.archived?'会话已归档，先 /unarchive 恢复。':this.selectionHint(session)}\n/models 查看模型。`,meta:{title:'已选中会话',command:'use',session,openId:message.openId}}};
        }
        if(name==='list_models') {
          const reply=await capture('/models');return {reply,result:{models:session.models}};
        }
        if(name==='run_command') {
          if(!this.authorized(message.openId))throw new Error('通道授权已撤销，未执行该操作');
          if(args.command==='assistant' && args.argument)throw new Error('切换助手模式无需参数，请继续发送你的请求');
          const reply=await capture(`/${args.command}${args.argument?' '+args.argument:''}`);
          return {terminal:['read','status','resume','assistant','help','fork'].includes(args.command) || !args.argument && ['model','effort'].includes(args.command),
            reply,result:{ok:true,command:args.command,settings:modelSettings(session)}};
        }
        if(name==='new_task') {
          if(!args.task.trim() || !message.text.includes(args.task))throw new Error('新建任务必须使用本次用户消息中的原文，不能自行添加内容');
          if(args.projectId) {
            await capture('/projects');
            const index=session.projects.findIndex(p=>p.projectId===args.projectId);
            if(index<0)throw new Error('新建目标不是可用项目');
            const reply=await capture(`/new ${index+1} | ${args.task}`);return {terminal:true,reply,result:{created:true}};
          }
          const reply=await capture(`/new - | ${args.task}`);return {terminal:true,reply,result:{created:true}};
        }
        if(name==='send_task') {
          if(!args.task.trim() || !message.text.includes(args.task))throw new Error('转交任务必须使用本次用户消息中的原文，不能自行添加内容');
          this.selected(session);
          const reply=await capture(`/send ${args.task}`);
          return {terminal:true,reply,result:{sent:true,threadId:session.selected.id}};
        }
        throw new Error('操作助手工具不受支持');
      }});
    this.saveState();
    if(result.reply)await this.send(message.chatId,result.reply.output,{...result.reply.meta,operatorModel:result.model});
    else await this.send(message.chatId,result.text,{kind:'operator',title:'操作助手',subtitle:result.model,session,openId:message.openId,operatorModel:result.model});
  }
  async handle(message,{capture=false}={}) {
    const session=this.session(message);
    const authorize=()=>{if(!this.authorized(message.openId))throw new Error('通道授权已撤销，未执行该操作');};
    const choice=message.text.match(/^选择\s*(\d+)$/);const page=message.text.match(/^第?\s*(\d+)\s*页$/);
    if(choice)message={...message,text:`/use ${choice[1]}`};
    else if(page)message={...message,text:`/page ${page[1]}`};
    else if(['项目列表','会话列表','帮助'].includes(message.text))message={...message,text:({'项目列表':'/projects','会话列表':'/chats','帮助':'/help'})[message.text]};
    else if(['操作助手','返回助手','切换会话'].includes(message.text))message={...message,text:'/assistant'};
    else if(['继续会话','进入直聊','进入这个会话聊天','进入会话聊天','和这个会话直接聊'].includes(message.text))message={...message,text:'/resume'};
    const match=message.text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    let command=match?.[1].toLowerCase();let arg=match?.[2]?.trim()||'';
    if(!command && session.view && ['下一页','上一页'].includes(message.text)) command=message.text==='下一页'?'next':'prev';
    if(!command && session.awaitingChoice && /^\d+$/.test(message.text)) {command=session.awaitingChoice==='project'?'project':'use';arg=message.text;}
    let output;let threadStatus;let conversation;
    switch(command) {
      case 'help': output=HELP+'\n\n'+currentTarget(session);break;
      case 'assistant': {
        session.mode='assistant';session.awaitingChoice=null;this.saveState();
        if(arg)return this.askAssistant({...message,text:arg});
        const status=this.operator?.status();
        output=`已打开操作助手。\n模型｜${status?.configured?status.model:'尚未配置'}\n\n可以直接说“帮我找到某项目里排查订单的会话”。\n选择会话后，后续消息会直接发给该会话。\n/projects、/chats、/models 仍由程序执行。`;break;
      }
      case 'resume': {
        const selected=this.selected(session);session.mode='chat';session.awaitingChoice=null;this.saveState();
        output=`已返回会话：${selected.title||selected.id}\n\n${modelSummary(session)}\n\n${CHAT_NEXT}`;break;
      }
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
      case 'pair':output='已配对，无需重复配对。/chats 查看列表，选中后直接发消息；/assistant 打开操作助手。\n'+HELP_HINT;break;
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
        output=`${selected.title||selected.id}\n${command==='archive'?'已归档。/unarchive 可以恢复；/chats 可以选择其他会话。':'已恢复。'+(session.mode==='assistant'?'重新选择这个会话后即可聊天。':'直接发消息即可继续聊天。')}`;break;
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
        if(!command && this.operator && (session.mode==='assistant' || !session.selected))return this.askAssistant(message);
        const prompt=command==='send'?arg:message.text;
        if(!prompt) throw new Error('请写上任务内容。例如：/send 帮我检查构建错误');
        const selected=this.selected(session);
        if(selected.archived) throw new Error('当前会话已归档。先发送 /unarchive 恢复，再直接聊天；或 /chats 选择其他会话。');
        const baseline=await this.readBeforeSend(session,authorize);
        // This text is an authenticated user's explicit instruction to this selected chat.
        authorize();
        try {await this.desktop.call('send_message_to_thread',{...threadArgs(selected),prompt,...taskModelArgs(session)},{beforeSend:authorize});}
        catch(error) {this.noteDeliveryFailure('send',error,session);if(error.notSent)throw error;throw new Error('桌面未确认发送结果。请先用 /read 或在桌面检查这条消息是否已进入会话，再决定是否重发。');}
        session.awaitingChoice=null;this.saveState();this.watch(session,baseline);output=`已发送到：${selected.title||selected.id}\n回复会自动发回${this.channelLabel}。\n/status 查看进度，/read 查看对话，/chats 切换会话。`;
      }
    }
    const listCommands=['chats','projects','project','archived','next','prev','page','more'];
    const meta={kind:listCommands.includes(command)?'list':command==='models'?'models':command==='read'?'conversation':command==='help'?'help':'info',
      title:CARD_TITLES[command||'send']||(command==='projectinfo'?'项目详情':'Codex'),session,openId:message.openId,updateMessageId:message.updateMessageId,
      command:command||'send',threadStatus,conversation};
    if(capture)return {output,meta};
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
  async poll() {
    for(const [key,watch] of [...this.watches]) {
      if(!this.authorized(watch.openId)) {this.watches.delete(key);continue;}
      try {
        const snapshot=threadSnapshot(await this.desktop.call('read_thread',{...threadArgs(watch.thread),turnLimit:1,maxOutputCharsPerItem:20000}));
        const assistant=snapshot.latestAssistantMessage;
        if(snapshot.latestTurn?.status==='completed' && assistant?.text && assistant.id!==watch.messageId) {
          await this.send(watch.chatId,assistant.text,{kind:'assistant',title:'Codex 回复',thread:watch.thread,openId:watch.openId,
            session:this.state.sessions[`${watch.openId}:${watch.chatId}`]});
          watch.messageId=assistant.id;
        }
        const status=snapshot.thread?.status?.type;
        if(status==='needsAttention' && !watch.attentionNotified) {await this.send(watch.chatId,`${watch.thread.title||watch.thread.id}\n需要你在 Codex 桌面处理审批或输入。\n/use ${watch.thread.id} 选中该会话，再 /open 在本机打开。`);watch.attentionNotified=true;}
        if(status!=='needsAttention') watch.attentionNotified=false;
        if(['completed','failed','interrupted'].includes(snapshot.latestTurn?.status) && snapshot.latestTurn?.id!==watch.baselineTurnId) {
          if(snapshot.latestTurn.status!=='completed') await this.send(watch.chatId,`会话${snapshot.latestTurn.status==='failed'?'执行失败':'已中断'}。请 /read 查看结果。`);
          this.watches.delete(key);
        }
      } catch(error) {
        await this.send(watch.chatId,`会话通知暂停：${error.message}`).catch(()=>{});this.watches.delete(key);
      }
    }
    this.persistWatches();
  }
}
