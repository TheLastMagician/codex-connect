import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {dataDir,secureDirectory,config,readJson,writeJson} from './storage.mjs';
import {DesktopClient} from './desktop.mjs';
import {stopControl} from './control.mjs';
import {randomBytes} from 'node:crypto';
import {VERSION} from './version.mjs';
import {beginWechatLogin,wechatLoginStatus,submitWechatVerifyCode,disconnectWechat} from './wechat-auth.mjs';
import {assistantStatus,configureAssistant} from './assistant.mjs';

function context(extra) {
  const meta=extra?._meta||{};
  const saved=readJson('desktop-context.json',{});
  let turn=meta['x-codex-turn-metadata'];
  if(typeof turn==='string') {try {turn=JSON.parse(turn);}catch{turn={};}}
  const threadId=turn?.thread_id || meta['openai/threadId'] || meta.threadId || process.env.CODEX_THREAD_ID || saved.threadId;
  const pipePath=process.env.CODEX_APP_TOOLS_PIPE_PATH || saved.pipePath;
  if(!pipePath || !threadId) throw new Error('需要在 Codex 桌面聊天中调用；缺少桌面工具管道或真实会话上下文');
  return {pipePath,threadId};
}
function alive(pid) {try {process.kill(pid,0);return true;}catch{return false;}}
const tools=[
  {name:'assistant_status',description:'查看操作助手接口、模型和强度配置，隐藏 API Key。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'configure_assistant',description:'用户要求配置操作助手时使用。凭据只保存在本机，不回显、不打包。使用 OpenAI 兼容 Chat Completions 工具调用接口；省略 apiKey 可保留已有凭据。',inputSchema:{type:'object',properties:{baseUrl:{type:'string'},model:{type:'string'},apiKey:{type:'string'},reasoningEffort:{type:'string'},enabled:{type:'boolean'}},additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'bridge_status',description:'查看飞书、微信及桌面桥接配置和运行状态，隐藏凭据。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'wechat_login',description:'用户要求连接微信时生成微信 ClawBot 登录二维码，自动等待扫码。显示返回的 qrPath 图片供用户用微信扫一扫。凭据只保存在本机。',inputSchema:{type:'object',properties:{refresh:{type:'boolean',description:'用户要求刷新过期二维码或换绑微信时设为 true'}},additionalProperties:false},annotations:{readOnlyHint:false,openWorldHint:true}},
  {name:'wechat_login_status',description:'查看微信扫码登录状态，隐藏 token；扫码确认后微信通道自动连接。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'wechat_verify_code',description:'仅当微信登录状态为 need_verifycode 且用户给出手机上的验证码时提交。',inputSchema:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'disconnect_wechat',description:'仅在用户要求断开或退出微信连接时使用，不影响飞书通道或 Codex 会话。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'desktop_probe',description:'只读检查本机 Codex 桌面的真实会话接口。不创建会话、不发送消息。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'create_pairing_code',description:'生成一次性飞书配对码，有效期 10 分钟。只有用户明确要求添加飞书控制账号时使用。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'configure_card_actions',description:'设置原生飞书卡片的按钮交互。只有用户确认已启用 card.action.trigger 长连接回调时才启用；关闭后仍显示卡片和文字命令。',inputSchema:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'start_bridge',description:'启动常驻桌面聊天桥接。飞书先配置 App ID/Secret，微信使用 wechat_login 扫码；可以同时启用。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,openWorldHint:true}},
  {name:'stop_bridge',description:'停止所有聊天通道的桥接服务。不会停止任何 Codex 会话。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false}}
];
async function startBridge(extra) {
  secureDirectory();const previous=readJson('status.json',{});
  if(previous.pid && alive(previous.pid) && !['stopped','failed'].includes(previous.state)) return {alreadyRunning:true,...previous};
  const settings=config();const wechat=wechatLoginStatus();
  if(!(settings.appId && settings.appSecret && settings.feishuEnabled!==false) && !wechat.configured && !['wait','scaned','need_verifycode'].includes(wechat.status)) throw new Error('请先配置飞书，或调用 wechat_login 扫码连接微信。');
  writeJson('desktop-context.json',context(extra));
  const log=fs.openSync(path.join(dataDir,'bridge.log'),'a',0o600);
  try {
    const child=spawn(process.execPath,[path.join(__dirname,'bridge.cjs')],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:process.env});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    return {startedProcess:true,pid:child.pid,note:'已启动进程，请用 bridge_status 核对各通道连接状态。'};
  }finally{fs.closeSync(log);}
}
const server=new Server({name:'feishu-codex-desktop',version:VERSION},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  try {
    let result;
    switch(request.params.name) {
      case 'assistant_status':result=assistantStatus();break;
      case 'configure_assistant':result=configureAssistant(request.params.arguments||{});break;
      case 'wechat_login': {
        context(extra);result=await beginWechatLogin({refresh:request.params.arguments?.refresh===true});
        await startBridge(extra);break;
      }
      case 'wechat_login_status':result=wechatLoginStatus();break;
      case 'wechat_verify_code':result=submitWechatVerifyCode(request.params.arguments?.code||'');break;
      case 'disconnect_wechat':result=disconnectWechat();break;
      case 'bridge_status': {
        const settings=readJson('config.json',{});const status=readJson('status.json',{state:'not-started'});
        const wechat=wechatLoginStatus();
        result={configured:!!(settings.appId && settings.appSecret) || wechat.configured,feishuConfigured:!!(settings.appId && settings.appSecret),wechatConfigured:wechat.configured,wechatLogin:wechat.status,pairedUsers:settings.allowedOpenIds?.length||0,
          pairingPending:!!(settings.pairing?.expiresAt>Date.now()),cardActionsEnabled:!!settings.cardActionsEnabled,...status,processAlive:!!status.pid && alive(status.pid),
          assistant:assistantStatus(),limitations:['无法停止桌面回复或代点审批','仅转发文字','桌面 App 需要保持运行','本机桌面工具接口可能随版本改变']};break;
      }
      case 'desktop_probe': {
        const desktop=new DesktopClient(context(extra));
        try {const catalog=await desktop.tools();const chats=await desktop.call('list_threads',{limit:1});
          result={ok:true,tools:catalog.map(tool=>tool.name),chatCount:(chats.pinnedThreads?.length||0)+(chats.threads?.length||0)};
        } finally{desktop.close();}break;
      }
      case 'create_pairing_code': {
        secureDirectory();const settings=config();
        settings.pairing={code:randomBytes(12).toString('hex'),expiresAt:Date.now()+10*60*1000};
        writeJson('config.json',settings);
        result={pairCommand:`/pair ${settings.pairing.code}`,expiresAt:settings.pairing.expiresAt};break;
      }
      case 'configure_card_actions': {
        const enabled=request.params.arguments?.enabled;
        if(typeof enabled!=='boolean') throw new Error('enabled 必须为 true 或 false');
        const settings=config();settings.cardActionsEnabled=enabled;writeJson('config.json',settings);
        result={cardActionsEnabled:enabled,note:'下一条回复生效，已发送的旧卡片可用 /projects 或 /chats 刷新。'};break;
      }
      case 'start_bridge': {
        result=await startBridge(extra);break;
      }
      case 'stop_bridge': {
        const lock=readJson('bridge.lock',{});
        if(lock.pid && alive(lock.pid)) await stopControl();
        result={stopRequested:true,note:'停止的是聊天通道桥接；Codex 会话继续运行。'};break;
      }
      default:throw new Error('未知工具');
    }
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  }catch(error){return {content:[{type:'text',text:error.message}],isError:true};}
});
async function main() {
  await server.connect(new StdioServerTransport());
  process.stdin.once('end',()=>server.close().finally(()=>process.exit(0)));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
