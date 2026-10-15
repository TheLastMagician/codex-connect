import {randomUUID,createHash} from 'node:crypto';
import {config,readJson,writeJson} from './storage.mjs';

const validId=id=>id==='default' || /^[0-9a-f-]{36}$/i.test(id);
export function requireBotId(id) {if(!validId(id))throw new Error('机器人标识无效');return id;}
export function feishuBots() {
  const legacy=config();
  return [{...legacy,id:'default',name:legacy.feishuName||'主机器人',enabled:legacy.feishuEnabled!==false,
    mode:legacy.feishuMode||'full',thread:legacy.feishuThread||null},...(readJson('feishu-bots.json',{bots:[]}).bots||[])];
}
export function feishuBot(id) {return feishuBots().find(bot=>bot.id===requireBotId(id));}
export function publicBot(bot) {
  return {id:bot.id,name:bot.name,appId:bot.appId||'',secretConfigured:!!bot.appSecret,enabled:bot.enabled,
    mode:bot.mode,thread:bot.thread||null,cardActionsEnabled:!!bot.cardActionsEnabled,allowedOpenIds:bot.allowedOpenIds||[],
    configured:!!(bot.appId && bot.appSecret),environmentCredentials:bot.id==='default' && !!(process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET)};
}
export function saveFeishuBot(input) {
  const id=input.id?requireBotId(input.id):randomUUID(),previous=feishuBot(id);
  if(input.id && !previous)throw new Error('机器人不存在，请刷新页面');
  if(previous?.id==='default' && (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) &&
    (input.appSecret || input.appId!==undefined && input.appId!==previous.appId))throw new Error('主机器人凭据由环境变量提供，请先在原配置来源修改');
  const bot={...previous,id,name:input.name??previous?.name??'飞书机器人',appId:input.appId??previous?.appId??'',
    appSecret:input.appSecret||previous?.appSecret||'',enabled:input.enabled??previous?.enabled??true,
    mode:input.mode??previous?.mode??'fixed',thread:input.thread??previous?.thread??null,
    cardActionsEnabled:input.cardActionsEnabled??previous?.cardActionsEnabled??false,allowedOpenIds:previous?.allowedOpenIds||[]};
  if(typeof bot.name!=='string' || !bot.name.trim() || bot.name.length>80)throw new Error('请输入 1–80 字的机器人名称');
  bot.name=bot.name.trim();
  if(!['full','fixed'].includes(bot.mode) || typeof bot.enabled!=='boolean' || typeof bot.cardActionsEnabled!=='boolean')throw new Error('机器人模式或开关无效');
  if(typeof bot.appId!=='string' || !/^cli_[0-9a-f]{16}$/i.test(bot.appId))throw new Error('请输入有效的飞书 App ID（cli_ 加 16 位十六进制字符）');
  if(typeof bot.appSecret!=='string' || !bot.appSecret.trim() || bot.appSecret.length>512 || /[\r\n]/.test(bot.appSecret))throw new Error('请填写 App Secret，已有凭据可留空保留');
  bot.appSecret=bot.appSecret.trim();
  if(feishuBots().some(other=>other.id!==id && other.appId===bot.appId))throw new Error('这个 App ID 已经配置，不能重复连接同一个机器人');
  if(bot.mode==='fixed' && (!bot.thread || typeof bot.thread.id!=='string' || !bot.thread.id || typeof bot.thread.hostId!=='string'))throw new Error('请先选择要绑定的真实 Codex 会话');
  persist(bot);return publicBot(bot);
}
function persist(bot) {
  if(bot.id==='default') {
    const saved=readJson('config.json',{});
    writeJson('config.json',{...saved,appId:bot.appId,appSecret:bot.appSecret,feishuName:bot.name,feishuEnabled:bot.enabled,
      feishuMode:bot.mode,feishuThread:bot.thread,cardActionsEnabled:bot.cardActionsEnabled,allowedOpenIds:bot.allowedOpenIds,
      ...(bot.pairing?{pairing:bot.pairing}:{})});
  }else {
    const saved=readJson('feishu-bots.json',{bots:[]});
    writeJson('feishu-bots.json',{...saved,bots:[...(saved.bots||[]).filter(other=>other.id!==bot.id),bot]});
  }
}
export function saveBotRuntime(id,value) {
  const previous=feishuBot(id);if(!previous)throw new Error('机器人已移除');
  const next={...previous,allowedOpenIds:value.allowedOpenIds||[]};
  if(value.pairing)next.pairing=value.pairing;else delete next.pairing;
  if(id==='default') {
    const saved=readJson('config.json',{});delete saved.pairing;
    writeJson('config.json',{...saved,allowedOpenIds:next.allowedOpenIds,...(next.pairing?{pairing:next.pairing}:{})});
  }else persist(next);
}
export function deleteFeishuBot(id) {
  requireBotId(id);if(id==='default')throw new Error('主机器人请使用停用开关，保留原有配对和配置');
  const saved=readJson('feishu-bots.json',{bots:[]});
  if(!saved.bots.some(bot=>bot.id===id))throw new Error('机器人不存在');
  writeJson('feishu-bots.json',{...saved,bots:saved.bots.filter(bot=>bot.id!==id)});
  const pending=readJson('feishu-requests.json',{});delete pending[id];writeJson('feishu-requests.json',pending);
}
export function rememberFeishuRequest(id,message) {
  const pending=readJson('feishu-requests.json',{}),entries=pending[id]||[];
  if(entries.some(entry=>entry.openId===message.openId && Date.now()-entry.lastSeenAt<30000))return;
  pending[id]=[{openId:message.openId,lastSeenAt:Date.now()},...entries.filter(entry=>entry.openId!==message.openId)].slice(0,30);
  writeJson('feishu-requests.json',pending);
}
export function authorizeFeishuUser(id,openId,allowed) {
  if(typeof openId!=='string' || !/^[\w-]{1,300}$/.test(openId) || typeof allowed!=='boolean')throw new Error('账号授权参数无效');
  const bot=feishuBot(id);if(!bot)throw new Error('机器人不存在');
  const pending=readJson('feishu-requests.json',{});
  if(allowed && !(bot.allowedOpenIds||[]).includes(openId) && !(pending[id]||[]).some(entry=>entry.openId===openId))throw new Error('请先给这个机器人发一条消息，再批准真实使用申请');
  bot.allowedOpenIds=allowed?[...new Set([...(bot.allowedOpenIds||[]),openId])]:(bot.allowedOpenIds||[]).filter(value=>value!==openId);
  persist(bot);pending[id]=(pending[id]||[]).filter(entry=>entry.openId!==openId);writeJson('feishu-requests.json',pending);
  return publicBot(bot);
}
export function feishuIdentity(bot) {return createHash('sha256').update(JSON.stringify([bot.appId,bot.appSecret,bot.enabled,bot.mode,bot.thread?.id,bot.thread?.hostId])).digest('hex');}
export function botStateName(bot) {
  if(bot.mode==='fixed')return `feishu-fixed-${bot.id}-${createHash('sha256').update(JSON.stringify([bot.thread?.id,bot.thread?.hostId])).digest('hex').slice(0,16)}.json`;
  return bot.id==='default'?'state.json':`feishu-state-${requireBotId(bot.id)}.json`;
}
