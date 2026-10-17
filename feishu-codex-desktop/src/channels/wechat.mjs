import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Router,fingerprint} from '../router.mjs';
import {PAGE_SIZE,statusLabel,currentTarget,projectName} from '../navigation.mjs';
import {readLocalThreads} from '../catalog.mjs';
import {WechatApi} from '../wechat-api.mjs';
import {readJson,writeJson} from '../storage.mjs';
import {readWechatAccount} from '../wechat-storage.mjs';
import {chunkMarkdown} from '../outbound.mjs';
import {modelSummary} from '../models.mjs';

// CommonMark soft line breaks are collapsed by some ClawBot clients. Use explicit
// hard breaks within a block and blank paragraphs between sections.
const lineBreak='  \n';
const sections=blocks=>blocks.filter(Boolean).join('\n\n');
const quick=(...items)=>items.join(' · ');
const tidyInfo=text=>String(text).replace(/\n发送 \/help 查看所有操作。\s*$/,'').split('\n\n').map(block=>block.split('\n').join(lineBreak)).join('\n\n');

export function parseWechatMessage(raw,account) {
  if(raw.message_type!==1 || raw.group_id || raw.from_user_id!==account.ownerUserId ||
    (raw.message_state!==undefined && raw.message_state!==2) || raw.delete_time_ms) return null;
  if(raw.to_user_id && raw.to_user_id!==account.botId) return null;
  if(!Array.isArray(raw.item_list)) return null;
  const text=raw.item_list.filter(i=>i.type===1 && typeof i.text_item?.text==='string').map(i=>i.text_item.text).join('\n').trim();
  const unsupported=raw.item_list.some(i=>[2,3,4,5].includes(i.type));
  if((!text && !unsupported) || text.length>12000 || !raw.context_token || !Number.isFinite(raw.create_time_ms)) return null;
  const id=raw.message_id??raw.client_id??raw.seq;
  if(id===undefined || id===null) return null;
  return {openId:raw.from_user_id,chatId:raw.from_user_id,id:`wechat:${account.botId}:${id}:${raw.create_time_ms}`,
    text,timestamp:raw.create_time_ms,contextToken:raw.context_token,unsupported};
}
export function wechatStateName(account) {
  const key=createHash('sha256').update(JSON.stringify([account.botId,account.ownerUserId])).digest('hex').slice(0,24);
  return `wechat-state-${key}.json`;
}
export function renderWechatReply(text,meta={}) {
  const s=meta.session;const selected=meta.thread||s?.selected;
  const name=selected?.title||selected?.id||'当前会话';
  if(meta.kind==='list' && s?.view) {
    const view=s.view;const projects=view.kind==='projects';const entries=projects?s.projects:s.threads;
    const page=view.page||1;const pages=Math.max(1,Math.ceil(entries.length/PAGE_SIZE));const start=(page-1)*PAGE_SIZE;
    const more=view.kind==='archived' && s.archiveCursor;
    const blocks=[`${projects?'📁 项目列表':view.kind==='archived'?'🗃 已归档会话':'💬 '+(view.title||'会话')}`,
      more?`第 ${page} 页 · 后面还有`:`第 ${page}/${pages} 页 · 共 ${entries.length} 项`,view.notice];
    const visible=entries.slice(start,start+PAGE_SIZE);
    for(const [offset,entry] of visible.entries()) {
      blocks.push(`${start+offset+1}｜${projects?entry.label:entry.title||'未命名会话'}`+
        (projects?'':`${lineBreak}${projectName(s,entry)} · ${statusLabel(entry.status)}${entry.pinnedIndex?' · 置顶':''}`));
    }
    if(!visible.length) blocks.push('没有匹配结果。换个关键词，或用 /chats 刷新。');
    const nav=[];if(page>1)nav.push('/prev 上一页');if(page<pages || more)nav.push('/next 下一页');
    if(nav.length)blocks.push(quick(...nav));
    if(visible.length)blocks.push(projects?`查看项目 → 回复 ${start+1}${lineBreak}新建任务 → /new ${start+1} | 任务内容`:
      `选择会话 → 回复 ${start+1} 或 /use ${start+1}${view.kind==='archived'?lineBreak+'选中后用 /unarchive 恢复。':''}`);
    if(s.selected)blocks.push('当前会话｜'+name);
    if(view.partialNotice)blocks.push(view.partialNotice);
    blocks.push(quick(projects?'/chats 会话':'/projects 项目','/help 帮助'));
    return sections(blocks);
  }
  if(meta.kind==='assistant' || meta.kind==='conversation')return sections([meta.kind==='conversation'?'💬 最近对话':'💬 Codex 回复',selected?'来自「'+name+'」':null,
    String(text),s?.selected?'直接回复即可继续 · /chats 切换会话':'/chats 选择会话后直接聊天']);
  if(meta.kind==='help')return sections(['🧭 使用指南',
    `开始${lineBreak}先发送 /projects 或 /chats，回复项目和会话编号。${lineBreak}选中后直接发消息，就是与该会话聊天。`,
    `选择与翻页${lineBreak}/chats 关键词 → 找会话${lineBreak}/use 12 → 选会话 12${lineBreak}/next 下一页 · /prev 上一页 · /page 2 跳页`,
    `查看任务${lineBreak}/read 最近回复 · /status 当前状态${lineBreak}/watch 开启通知 · /unwatch 关闭通知`,
    `模型${lineBreak}/models 可用模型 · /model 查看设置${lineBreak}/model 模型ID → 设置 · /model default → 沿用桌面${lineBreak}/effort high → 推理强度`,
    `管理会话${lineBreak}/rename 标题 → 重命名${lineBreak}/pin 置顶 · /unpin 取消置顶${lineBreak}/archive 归档 · /archived 归档列表${lineBreak}/unarchive 恢复 · /fork 复制 · /open 本机打开`,
    `新建${lineBreak}/new 1 | 任务内容 → 在项目 1 中新建${lineBreak}/new - | 任务内容 → 新建独立会话`,
    '沿用原会话模型与上下文。停止任务、处理审批请在 Codex 桌面操作。',
    s?.selected?'当前会话｜'+name:'尚未选择会话，先发送 /projects。']);
  if(meta.kind==='error')return sections(['⚠️ 操作未完成',tidyInfo(text)]);
  if(['use','fork'].includes(meta.command))return sections([meta.command==='fork'?'✅ 已复制并选中':'✅ 已选中会话',name,
    modelSummary(s).split('\n').join(lineBreak),
    selected?.archived?'会话已归档。发送 /unarchive 恢复。':'直接发消息即可继续这个会话。',
    quick('/models 模型','/read 查看回复','/chats 切换会话')]);
  if(['发送核对中','发送已确认'].includes(meta.title))return sections(['📨 '+meta.title,tidyInfo(text),quick('/status 当前状态','/read 查看回复')]);
  if(['send','new'].includes(meta.command))return sections([meta.command==='new'?'✨ 新会话已开始':'📨 任务已发送',name,
    '完成后会自动在微信回复。',quick('/status 查看进度','/read 查看回复')]);
  if(meta.command==='status')return sections(['📍 当前会话',name,
    '状态｜'+statusLabel(meta.threadStatus),modelSummary(s).split('\n').join(lineBreak),selected?.archived?'已归档，使用 /unarchive 恢复。':null,
    quick('/read 查看回复','/models 模型','/chats 切换会话')]);
  return sections([meta.title||'Codex',tidyInfo(text)]);
}
export function splitWechatText(text,limit=1500) {
  return chunkMarkdown(text,limit);
}
export function createWechatChannel({desktop,account,onStatus,api=new WechatApi({baseUrl:account.baseUrl,token:account.token}),
  loadState=()=>readJson(wechatStateName(account),{sessions:{},seen:{}}),save=state=>writeJson(wechatStateName(account),state),
  currentAccount=readWechatAccount,wait=delay}) {
  const state=loadState();state.contexts ||= {};
  const saveState=()=>save(state);const stopController=new AbortController();let loop;let stopped=false;
  const active=()=>{const current=currentAccount();return !stopped && current.enabled && current.token===account.token && current.ownerUserId===account.ownerUserId && current.botId===account.botId;};
  const getConfig=()=>({allowedOpenIds:active()?[account.ownerUserId]:[]});
  const send=async(userId,text,meta={})=>{
    if(!active() || userId!==account.ownerUserId) throw new Error('微信通道已断开，请重新连接。');
    const token=state.contexts[userId]?.token;if(!token)throw new Error('请先在微信发送 /help，建立回复上下文。');
    const parts=splitWechatText(renderWechatReply(text,meta));
    for(const [index,part] of parts.entries()) {
      if(!active()) throw new Error('微信通道已断开。');
      await api.sendText(userId,parts.length>1?`（${index+1}/${parts.length}）\n\n${part}`:part,token,{signal:stopController.signal});
    }
    onStatus({lastReplyAt:Date.now()});
  };
  const router=new Router({desktop,getLocalThreads:readLocalThreads,getConfig,saveConfig:()=>{},state,saveState,send,channelLabel:'微信'});
  async function receiveBatch(result) {
    if(!Array.isArray(result.msgs))throw new Error('微信消息响应无效');
    for(const raw of result.msgs) {
      if(!active())return;
      const message=parseWechatMessage(raw,account);
      if(!message || Math.abs(Date.now()-message.timestamp)>10*60*1000)continue;
      state.contexts[message.openId]={token:message.contextToken,updatedAt:Date.now()};saveState();
      if(message.unsupported) {
        const key=fingerprint(message);if(state.seen?.[key])continue;
        (state.seen ||= {})[key]=Date.now();saveState();
        await send(message.openId,'当前微信通道支持文字任务。请把要执行的内容写成文字发送；/help 查看操作。',{title:'请发送文字任务'});continue;
      }
      router.acceptMessage(message);onStatus({lastReceiveAt:Date.now()});
      // Finish the queued action before persisting the server cursor. Dedup is durable before mutations.
      await Promise.all(router.queues.values());
    }
    if(result.get_updates_buf)state.cursor=result.get_updates_buf;
    saveState();
  }
  async function monitor() {
    let failures=0;let timeoutMs=35000;
    try{await api.bot('msg/notifystart',{}, {signal:stopController.signal});}catch{/* Optional lifecycle notification. */}
    while(active()) {
      try {
        const result=await api.updates(state.cursor||'',{signal:stopController.signal,timeoutMs});
        if(!active())return;
        await receiveBatch(result);failures=0;onStatus({state:'connected',lastPollAt:Date.now(),error:null});
        if(Number.isFinite(result.longpolling_timeout_ms))timeoutMs=Math.max(10000,Math.min(60000,result.longpolling_timeout_ms+5000));
        await wait(300,undefined,{signal:stopController.signal});
      }catch(error) {
        if(stopped || stopController.signal.aborted)return;
        if(error.code===-14) {onStatus({state:'login_required',error:'微信登录已失效，请在 Codex 中重新扫码连接。'});return;}
        onStatus({state:'reconnecting',error:'微信连接暂时失败，正在重连。',lastTransportErrorAt:Date.now()});
        try{await wait(Math.min(30000,1000*2**Math.min(++failures,5)),undefined,{signal:stopController.signal});}catch{return;}
      }
    }
  }
  return {id:'wechat',router,receiveBatch,
    preview:async()=>{
      const sessions=Object.values(state.sessions||{}).filter(s=>s.openId===account.ownerUserId);
      const session=sessions[0];if(!session)throw new Error('请先在微信发送 /help。');
      const previous=router.queues.get(session.chatId)||Promise.resolve();
      const work=previous.then(()=>router.handle({openId:session.openId,chatId:session.chatId,text:session.selected?'/status':'/help'}));
      router.queues.set(session.chatId,work);
      try{await work;}finally{if(router.queues.get(session.chatId)===work)router.queues.delete(session.chatId);}
    },
    start:async()=>{onStatus({state:'connecting'});loop=monitor().catch(()=>onStatus({state:'failed',error:'微信通道停止，请查看连接状态。'}));},
    stop:async()=>{stopped=true;stopController.abort();await loop;},
    poll:async()=>{if(active())await router.poll();}
  };
}
