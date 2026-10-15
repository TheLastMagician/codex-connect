import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {dataDir,readJson,writeJson} from './storage.mjs';
import {equalSecret} from './router.mjs';
import {feishuBots,feishuBot,publicBot,saveFeishuBot,deleteFeishuBot,authorizeFeishuUser} from './connections.mjs';
import {readLocalThreads} from './catalog.mjs';
import {readWechatAccount} from './wechat-storage.mjs';
import {beginWechatLogin,wechatLoginStatus,submitWechatVerifyCode,disconnectWechat} from './wechat-auth.mjs';
import {autostartStatus,configureAutostart} from './autostart-settings.mjs';

const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
const assets={'/':['dashboard.html','text/html; charset=utf-8'],'/dashboard.js':['dashboard.js','text/javascript; charset=utf-8'],
  '/dashboard.css':['dashboard.css','text/css; charset=utf-8'],'/icon.png':['dashboard-icon.png','image/png']};
class InputError extends Error {}
function fields(value,allowed) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)))throw new InputError('请求参数无效，请刷新页面后重试');
}
async function body(request) {
  if(request.headers['content-type']?.split(';')[0]!=='application/json')throw new InputError('请使用 JSON 请求');
  let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw new InputError('请求内容过长');}
  try{return JSON.parse(raw);}catch{throw new InputError('请求内容无效');}
}
export function dashboardLink() {
  const saved=readJson('dashboard.json',{});
  if(!saved.port || !saved.token)throw new Error('管理页面尚未启动，请稍后重试');
  return `http://127.0.0.1:${saved.port}/#${saved.token}`;
}
export async function createDashboard({desktop,getStatus=()=>readJson('status.json',{}),onChange=()=>{},bundleDir=directory,port,
  localThreads=readLocalThreads,wechat={begin:beginWechatLogin,status:wechatLoginStatus,verify:submitWechatVerifyCode,disconnect:disconnectWechat}}) {
  const saved=readJson('dashboard.json',{}),token=saved.token||randomBytes(32).toString('hex'),csrf=saved.csrf||randomBytes(32).toString('hex');
  let actualPort;const cookieName=()=>`codex_connect_${actualPort}`;
  const authenticated=request=>equalSecret((request.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(cookieName()+'='))?.slice(cookieName().length+1),token);
  const changed=()=>{writeJson('autostart-pause.json',{});Promise.resolve().then(onChange).catch(()=>{});};
  const catalog=async()=>{
    let result,projects;
    try{[result,projects]=await Promise.all([desktop.call('list_threads',{limit:50}),desktop.call('list_projects')]);}
    catch{throw new InputError('暂时无法读取 Codex 桌面，请确认桌面应用正在运行，再刷新列表');}
    const available=(projects.projects||[]).filter(project=>project.projectKind!=='chatgpt');
    let historical=[],complete=true;try{historical=await localThreads(available);}catch{complete=false;}
    const key=t=>`${t.hostId||'local'}:${t.id}`,merged=new Map(historical.map(t=>[key(t),t]));
    for(const thread of [...(result.pinnedThreads||[]),...(result.threads||[])])merged.set(key(thread),{...merged.get(key(thread)),...thread,projectId:thread.projectId||merged.get(key(thread))?.projectId});
    const threads=[...merged.values()].filter(t=>t.kind==='codex' && !t.archived).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))
      .map(t=>({id:t.id,hostId:t.hostId||'local',title:t.title||t.id,projectId:t.projectId||null,projectLabel:available.find(p=>p.projectId===t.projectId)?.label||'独立会话'}));
    return {projects:available.map(p=>({projectId:p.projectId,label:p.label,path:p.path||'',hostId:p.hostId||'local'})),threads,complete,
      notice:!complete?'历史目录暂时不可用，当前仅显示最近会话和置顶会话。':available.some(p=>p.hostId && p.hostId!=='local')?'本机会话已完整加载，远程主机仅显示最近会话。':null};
  };
  const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const origin=`http://127.0.0.1:${actualPort}`;
      if(request.headers.host!==`127.0.0.1:${actualPort}` || request.headers['sec-fetch-site']==='cross-site')return json(response,{error:'仅允许本机页面访问'},403);
      const url=new URL(request.url,origin),route=url.pathname;
      if(request.method==='GET' && assets[route]) {
        const [file,type]=assets[route];response.writeHead(200,{'Content-Type':type});response.end(fs.readFileSync(path.join(bundleDir,file)));return;
      }
      if(request.method==='POST' && route==='/api/session') {
        if(request.headers.origin!==origin)return json(response,{error:'页面来源无效'},403);
        const input=await body(request);fields(input,['token']);if(!equalSecret(input.token,token))return json(response,{error:'访问链接已失效，请在 Codex 中重新打开配置页'},401);
        response.setHeader('Set-Cookie',`${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);return json(response,{csrf});
      }
      if(!route.startsWith('/api/'))return json(response,{error:'页面不存在'},404);
      if(!authenticated(request))return json(response,{error:'请通过插件的“打开配置页面”入口访问'},401);
      if(request.method==='GET' && route==='/api/session')return json(response,{csrf});
      const mutation=['POST','PUT','DELETE'].includes(request.method);
      if(mutation && (request.headers.origin!==origin || !equalSecret(request.headers['x-codex-csrf'],csrf)))return json(response,{error:'页面验证失效，请刷新后重试'},403);
      if(request.method==='GET' && route==='/api/state') {
        const account=readWechatAccount(),login=wechat.status(),status=getStatus();
        return json(response,{version:status.version,state:status.state,desktopConnected:!!status.desktopConnected,channels:status.channels||{},
          paused:autostartStatus().pausedForCurrentDesktop,bots:feishuBots().map(publicBot),requests:readJson('feishu-requests.json',{}),
          wechat:{enabled:!!account.enabled,configured:!!(account.token && account.botId && account.ownerUserId),status:login.status,
            loginId:login.loginId,expiresAt:login.expiresAt,hasQr:['wait','scaned'].includes(login.status),needsCode:login.status==='need_verifycode'},autostart:autostartStatus()});
      }
      if(request.method==='GET' && route==='/api/catalog')return json(response,await catalog());
      if(request.method==='GET' && route==='/api/wechat/qr') {
        const login=wechat.status();if(!['wait','scaned'].includes(login.status) || !login.qrPath || login.expiresAt<=Date.now())throw new InputError('二维码已失效，请刷新二维码');
        const file=path.resolve(login.qrPath),expected=path.join(dataDir,`wechat-login-${login.loginId}.png`);
        if(!/^[0-9a-f-]{36}$/i.test(login.loginId||'') || file!==expected)throw new InputError('二维码文件无效');
        response.writeHead(200,{'Content-Type':'image/png'});response.end(fs.readFileSync(file));return;
      }
      if(!mutation)return json(response,{error:'接口不存在'},404);
      const input=await body(request);
      if((request.method==='POST' || request.method==='PUT') && route==='/api/bots') {
        fields(input,['id','name','appId','appSecret','enabled','mode','thread','cardActionsEnabled']);
        if(input.id!==undefined && typeof input.id!=='string')throw new InputError('机器人标识无效');
        const previous=input.id?feishuBot(input.id):null,mode=input.mode||previous?.mode||'fixed';
        if(mode==='fixed') {
          const target=input.thread||previous?.thread;if(input.thread)fields(input.thread,['id','hostId']);
          if(!target || typeof target.id!=='string' || typeof target.hostId!=='string')throw new InputError('请先选择要绑定的真实 Codex 会话');
          const unchanged=previous?.mode==='fixed' && target.id===previous.thread?.id && target.hostId===previous.thread?.hostId;
          if(unchanged)input.thread=previous.thread;
          else {const real=(await catalog()).threads.find(t=>t.id===target.id && t.hostId===target.hostId);if(!real)throw new InputError('请选择列表中的真实会话，目标可能已归档或不可用');input.thread=real;}
        }
        const bot=saveFeishuBot(input);changed();return json(response,{bot});
      }
      const match=route.match(/^\/api\/bots\/([^/]+)(\/users)?$/);
      if(match && request.method==='DELETE' && !match[2]) {fields(input,[]);deleteFeishuBot(match[1]);changed();return json(response,{deleted:true});}
      if(match?.[2] && request.method==='POST') {fields(input,['openId','allowed']);const bot=authorizeFeishuUser(match[1],input.openId,input.allowed);changed();return json(response,{bot});}
      if(request.method==='POST' && route==='/api/wechat/login') {fields(input,['refresh']);if(input.refresh!==undefined && typeof input.refresh!=='boolean')throw new InputError('刷新选项无效');await wechat.begin({refresh:input.refresh===true});changed();return json(response,{started:true});}
      if(request.method==='POST' && route==='/api/wechat/verify') {fields(input,['code']);wechat.verify(input.code);return json(response,{submitted:true});}
      if(request.method==='POST' && route==='/api/wechat/disconnect') {fields(input,[]);wechat.disconnect();changed();return json(response,{disconnected:true});}
      if(request.method==='POST' && route==='/api/wechat/enabled') {
        fields(input,['enabled']);const account=readWechatAccount();if(typeof input.enabled!=='boolean' || !account.token)throw new InputError('请先扫码连接微信');
        writeJson('wechat.json',{...account,enabled:input.enabled});changed();return json(response,{enabled:input.enabled});
      }
      if(request.method==='POST' && route==='/api/autostart') {fields(input,['enabled']);return json(response,configureAutostart(input.enabled,{bundleDir}));}
      if(request.method==='POST' && route==='/api/resume') {fields(input,[]);changed();return json(response,{resumed:true});}
      return json(response,{error:'接口不存在'},404);
    }catch(error) {
      // Do not reflect SDK errors, credential-bearing responses or stack traces.
      const safe=error instanceof InputError || /^(机器人|主机器人|这个 App ID|请|账号|当前没有|主机器人凭据|首次|现有 hooks|缺少自动)/.test(error.message);
      if(!response.headersSent)json(response,{error:safe?error.message:'操作未完成，请稍后重试并检查连接状态'},400);else response.end();
    }
  });
  const listen=preferred=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(preferred,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  try{await listen(port??saved.port??32147);}catch(error){if(port!==undefined || error.code!=='EADDRINUSE')throw error;await listen(0);}
  actualPort=server.address().port;
  writeJson('dashboard.json',{token,csrf,port:actualPort,pid:process.pid});
  return {baseUrl:`http://127.0.0.1:${actualPort}/`,port:actualPort,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
