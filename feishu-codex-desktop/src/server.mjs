import path from 'node:path';
import fs from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {secureDirectory,config,readJson,writeJson} from './storage.mjs';
import {DesktopClient} from './desktop.mjs';
import {stopControl} from './control.mjs';
import {randomBytes} from 'node:crypto';
import {VERSION} from './version.mjs';
import {beginWechatLogin,wechatLoginStatus,submitWechatVerifyCode,disconnectWechat} from './wechat-auth.mjs';
import {desktopContext,ensureBridge,alive,pauseAutostart} from './bridge-lifecycle.mjs';
import {configureAutostart,autostartStatus,syncAutostartRuntime} from './autostart-settings.mjs';
import {providerCatalogStatus,responsesCompatStatus,configureResponsesCompat,syncResponsesCompatRuntime,ensureResponsesCompat} from './responses-compat-settings.mjs';
import {SETTINGS_URI,SETTINGS_REQUEST_SCHEMA,settingsRequest,connectionSettings,SETTINGS_READ_OUTPUT,SETTINGS_UPDATE_INPUT} from './settings-panel.mjs';
import {feishuBots,publicBot} from './connections.mjs';
import {setTimeout as delay} from 'node:timers/promises';

function context(extra) {
  return desktopContext(extra);
}
const icons=['light','dark'].map(theme=>({src:'data:image/png;base64,'+fs.readFileSync(path.join(__dirname,theme==='dark'?'entrypoint-icon-dark.png':'entrypoint-icon.png')).toString('base64'),mimeType:'image/png',sizes:['128x128'],theme}));
const tools=[
  {name:'open_settings',title:'Codex 连接',icons,description:'在 Codex 内打开通道配置面板。管理飞书、微信、多个机器人、固定会话绑定与账号授权，无需浏览器网址。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:SETTINGS_URI},'openai/ui':{entrypoints:[{type:'global'}]}}},
  {name:'open_thread_settings',title:'通道配置',icons,description:'在当前聊天旁打开飞书、微信与机器人配置面板。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:SETTINGS_URI},'openai/ui':{entrypoints:[{type:'thread'}]}}},
  {name:'settings_request',description:'通道配置面板使用的本机配置操作，不创建会话、不发送任务。',inputSchema:SETTINGS_REQUEST_SCHEMA,annotations:{readOnlyHint:false},_meta:{ui:{visibility:['app']}}},
  {name:'read_connection_settings',description:'读取插件详情页的通道配置入口与自动连接设置。',inputSchema:{type:'object',properties:{},additionalProperties:false},outputSchema:SETTINGS_READ_OUTPUT,annotations:{readOnlyHint:true}},
  {name:'update_connection_settings',description:'保存插件详情页的自动连接设置。',inputSchema:SETTINGS_UPDATE_INPUT,outputSchema:{type:'object',properties:{values:{type:'object'}},required:['values']},annotations:{readOnlyHint:false}},
  {name:'responses_compat_status',description:'查看本机第三方 Responses 兼容层与供应商地址，不读取或返回 API Key。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'configure_responses_compat',description:'仅用于关闭 0.4.1 已启用的全局 Responses 兼容，恢复供应商原地址。enabled 只能为 false；恢复后需重启桌面。不能启用全局代理或声称仅兼容新建。',inputSchema:{type:'object',properties:{providerId:{type:'string'},enabled:{type:'boolean',enum:[false]}},required:['providerId','enabled'],additionalProperties:false},annotations:{readOnlyHint:false}},
  {name:'configure_autostart',description:'用户要求随 Codex 自动连接时开启；在本机注册启动/恢复会话钩子，需要用户在设置的钩子页信任一次。关闭仅取消自启动，不停止当前桥接。',inputSchema:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false},annotations:{readOnlyHint:false}},
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
  return ensureBridge(context(extra),{entryPath:path.join(__dirname,'bridge.cjs')});
}
async function managementService(extra) {
  syncAutostartRuntime(__dirname);
  let current;try{current=context(extra);}catch{current={};}
  return ensureBridge(current,{entryPath:path.join(__dirname,'bridge.cjs'),management:true});
}
async function autoConnect(extra) {
  if(readJson('autostart.json',{}).enabled!==true)return;
  try {
    const result=await ensureBridge(context(extra),{entryPath:path.join(__dirname,'bridge.cjs'),automatic:true});
    writeJson('autostart-status.json',{state:result.skipped||'started',checkedAt:Date.now()});
  }catch {writeJson('autostart-status.json',{state:'waiting_desktop',checkedAt:Date.now()});}
}
async function settingsReady(extra) {
  const saved=readJson('dashboard.json',{}),lock=readJson('bridge.lock',{});
  if(saved.pid && saved.pid===lock.pid && saved.port && alive(saved.pid))return;
  const started=await managementService(extra);
  for(let i=0;i<100;i++){const saved=readJson('dashboard.json',{});if(saved.pid===started.pid && saved.port)return;await delay(100);}
  throw new Error('配置服务正在启动，请稍后重新打开面板');
}
const server=new Server({name:'feishu-codex-desktop',version:VERSION,icons},{capabilities:{tools:{},resources:{},experimental:{'openai/settings':{readTool:'read_connection_settings',updateTool:'update_connection_settings'}}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:SETTINGS_URI,name:'Codex 连接 · 通道配置',mimeType:'text/html;profile=mcp-app'}]}));
server.setRequestHandler(ReadResourceRequestSchema,async request=>{
  if(request.params.uri!==SETTINGS_URI)throw new Error('未知面板资源');
  return {contents:[{uri:SETTINGS_URI,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(path.join(__dirname,'settings-panel.html'),'utf8'),
    _meta:{ui:{prefersBorder:false,csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':{availableDisplayModes:['inline','fullscreen'],preferredDisplayMode:'fullscreen'}}}]};
});
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  try {
    let result;
    switch(request.params.name) {
      case 'open_settings':case 'open_thread_settings':await settingsReady(extra);result={ready:true,note:'在 Codex 面板内管理飞书、微信和专用机器人。'};break;
      case 'settings_request':result=await settingsRequest(request.params.arguments,{ready:()=>settingsReady(extra)});return {content:[],structuredContent:result};
      case 'read_connection_settings':result=connectionSettings(autostartStatus().enabled);break;
      case 'update_connection_settings': {
        const args=request.params.arguments,set=args?.set;
        if(!args || Object.keys(args).some(k=>k!=='set') || !set || Object.keys(set).length!==1 || typeof set.autostart!=='boolean')throw new Error('自动连接设置无效');
        configureAutostart(set.autostart,{bundleDir:__dirname});if(set.autostart)await autoConnect(extra);
        result={values:{autostart:autostartStatus().enabled}};break;
      }
      case 'responses_compat_status':result={...responsesCompatStatus(),catalog:await providerCatalogStatus()};break;
      case 'configure_responses_compat':result=await configureResponsesCompat(request.params.arguments||{});break;
      case 'configure_autostart': {
        result=configureAutostart(request.params.arguments?.enabled,{bundleDir:__dirname});
        if(result.enabled)await autoConnect(extra);
        break;
      }
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
          bots:feishuBots().map(publicBot),
          responsesCompat:responsesCompatStatus(),autostart:{...autostartStatus(),lastAttempt:readJson('autostart-status.json',{})},
          limitations:['无法停止桌面回复或代点审批','飞书本机会话支持文字和图片；微信仅文字','桌面 App 需要保持运行','本机桌面工具接口可能随版本改变']};break;
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
        pauseAutostart();
        const lock=readJson('bridge.lock',{});
        if(lock.pid && alive(lock.pid)) await stopControl();
        result={stopRequested:true,note:'本次桌面运行期间暂停自动启动；重启 Codex 或手动 start_bridge 后恢复。Codex 会话继续运行。'};break;
      }
      default:throw new Error('未知工具');
    }
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  }catch(error){return {content:[{type:'text',text:error.message}],isError:true};}
});
async function main() {
  if(readJson('responses-compat.json',{}).routes?.length) {
    try{syncResponsesCompatRuntime(__dirname);await ensureResponsesCompat();}catch{}
  }
  // Finish claiming the single background process before serving tools. This
  // prevents a late startup from racing a user's stop request or MCP shutdown.
  await managementService().catch(()=>writeJson('dashboard-startup.json',{state:'failed',checkedAt:Date.now()}));
  await server.connect(new StdioServerTransport());
  process.stdin.once('end',()=>server.close().finally(()=>process.exit(0)));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
