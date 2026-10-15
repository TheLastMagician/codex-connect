import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {dataDir,readJson,writeJson,secureDirectory} from './storage.mjs';
import {alive} from './bridge-lifecycle.mjs';

const execute=promisify(execFile);
const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
const runtime=path.join(dataDir,'runtime');
const registry='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const registryName='CodexConnectResponsesCompat';
const home=()=>process.env.CODEX_HOME||path.join(os.homedir(),'.codex');

export async function providerConfig(request,{codexHome=home(),python=process.env.FEISHU_CODEX_PYTHON||'python',script=path.join(directory,'provider-config.py')}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-X','utf8',script],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output='';const fail=()=>reject(new Error('无法安全读取或更新供应商配置，需要 Python 3.11+。'));
    const timer=setTimeout(()=>{child.kill();fail();},10000);
    child.once('error',()=>{clearTimeout(timer);fail();});
    child.stdout.on('data',data=>{output+=data;if(output.length>65536){child.kill();fail();}});
    child.once('exit',code=>{
      clearTimeout(timer);try{const parsed=JSON.parse(output);if(code!==0 || parsed.error){fail();return;}resolve(parsed);}catch{fail();}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...request,codexHome}));
  });
}
function safeBase(value) {
  let url;try{url=new URL(value);}catch{throw new Error('供应商接口地址无效。');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash)
    throw new Error('仅支持未在地址中嵌入凭据的 HTTPS Responses 供应商。');
  return url.href.replace(/\/?$/,'/');
}
export async function providerCatalogStatus() {
  const catalog=await providerConfig({action:'list'});
  return {...catalog,providers:catalog.providers.map(provider=>{
    let baseUrl='[接口地址无效]';
    try{const url=new URL(provider.baseUrl);baseUrl=url.origin+url.pathname;}catch{}
    return {...provider,baseUrl};
  })};
}
export function responsesCompatStatus() {
  const saved=readJson('responses-compat.json',{}),status=readJson('responses-compat-status.json',{});
  return {enabled:!!saved.routes?.length,processAlive:alive(status.pid),version:status.version||null,
    port:saved.port||null,converted:status.instanceId===saved.instanceId?status.converted||0:0,
    providers:(saved.routes||[]).map(route=>({id:route.providerId,upstream:route.upstream,baseUrl:route.baseUrl})),
    note:'只转换缺少 call_id 的 Codex 原生转交记录。正常工具结果、模型、认证及权限保持原设置。更换供应商地址后需重启 Codex 才能使已加载的配置生效。'};
}
export function syncResponsesCompatRuntime(bundleDir) {
  secureDirectory();fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  for(const name of ['responses-compat-daemon.cjs','provider-config.py']) {
    const source=path.join(bundleDir,name);if(!fs.existsSync(source))throw new Error('缺少 Responses 兼容组件，请更新插件。');
    const target=path.join(runtime,name),temp=target+'.'+randomUUID()+'.tmp';
    try{fs.copyFileSync(source,temp);fs.renameSync(temp,target);}finally{try{fs.unlinkSync(temp);}catch{}}
  }
}
async function lock(name,action) {
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});const file=path.join(dataDir,name);let descriptor;
  const deadline=Date.now()+12000;
  while(descriptor===undefined) {
    try{descriptor=fs.openSync(file,'wx',0o600);fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid}));}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let previous;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
      if(previous?.pid && !alive(previous.pid)){try{fs.unlinkSync(file);}catch{}continue;}
      if(Date.now()>=deadline)throw new Error('另一个兼容设置操作尚未完成。');await delay(100);
    }
  }
  try{return await action();}finally{fs.closeSync(descriptor);try{fs.unlinkSync(file);}catch{}}
}
async function healthy(settings,status) {
  if(!alive(status.pid) || settings.instanceId!==status.instanceId || !Number.isInteger(status.port))return false;
  try {
    const response=await fetch(`http://127.0.0.1:${status.port}/health/${settings.instanceId}`,{signal:AbortSignal.timeout(1000),redirect:'error'});
    const result=await response.json();return response.ok && result.service==='codex-connect-responses' && result.instanceId===settings.instanceId;
  }catch{return false;}
}
export async function ensureResponsesCompat() {
  if(!readJson('responses-compat.json',{}).routes?.length)return {enabled:false};
  return lock('responses-compat-start.lock',async()=>{
    const settings=readJson('responses-compat.json',{});if(!settings.routes?.length)return {enabled:false};
    let status=readJson('responses-compat-status.json',{});
    if(await healthy(settings,status))return status;
    const entry=path.join(runtime,'responses-compat-daemon.cjs');
    if(!fs.existsSync(entry))throw new Error('本机 Responses 兼容运行文件丢失，请更新插件。');
    const child=spawn(process.execPath,[entry,'--codex-connect-data-dir',dataDir],{windowsHide:true,detached:true,stdio:'ignore',env:process.env});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    for(let index=0;index<50;index++) {
      await delay(100);status=readJson('responses-compat-status.json',{});
      if(status.pid===child.pid && await healthy(settings,status))return status;
      if(!alive(child.pid))break;
    }
    throw new Error('本机 Responses 兼容服务未能就绪；未修改供应商地址。');
  });
}
export async function setCompatStartup(enabled,{entry=path.join(runtime,'responses-compat-daemon.cjs')}={}) {
  if(process.platform!=='win32')throw new Error('本版兼容服务自动启动仅支持 Windows。');
  if(enabled)await execute('reg.exe',['add',registry,'/v',registryName,'/t','REG_SZ','/d',`"${process.execPath}" "${entry}" --codex-connect-data-dir "${dataDir}"`,'/f'],{windowsHide:true});
  else await execute('reg.exe',['delete',registry,'/v',registryName,'/f'],{windowsHide:true}).catch(()=>{});
}
export async function configureResponsesCompat({providerId,enabled},{bundleDir,
  desktopPipePath,config:configOverride,codexHome,startup=setCompatStartup,ensure=ensureResponsesCompat}={}) {
  if(typeof enabled!=='boolean' || typeof providerId!=='string' || !providerId)throw new Error('需要真实供应商 ID 和 enabled。');
  return lock('responses-compat-config.lock',async()=>{
    const previous=readJson('responses-compat.json',{}),existing=previous.routes?.find(r=>r.providerId===providerId);
    const config=configOverride||(request=>providerConfig(request,{codexHome:existing?.codexHome||codexHome||home()}));
    const catalog=await config({action:'list'}),provider=catalog.providers.find(p=>p.id===providerId);
    if(!provider)throw new Error('未找到这个已配置的供应商。');
    const backup=()=>path.join(dataDir,'provider-backups',`${Date.now()}-${randomUUID()}.toml`);
    if(!enabled) {
      if(existing && provider.baseUrl===existing.baseUrl)await config({action:'update',providerId,expected:existing.baseUrl,replacement:existing.originalBaseUrl,backupPath:backup()});
      const next={...previous,routes:(previous.routes||[]).filter(r=>r.providerId!==providerId),
        disabledProviders:[...new Set([...(previous.disabledProviders||[]),providerId])]};
      writeJson('responses-compat.json',next);if(!next.routes.length)await startup(false);
      return responsesCompatStatus();
    }
    if(existing) {
      if(provider.baseUrl!==existing.baseUrl)throw new Error('供应商地址已在插件外更改；请先关闭此供应商的兼容设置。');
      writeJson('responses-compat.json',{...previous,disabledProviders:(previous.disabledProviders||[]).filter(id=>id!==providerId)});
      await ensure();return responsesCompatStatus();
    }
    if(provider.wireApi!=='responses' || provider.supportsWebsockets)throw new Error('兼容层仅支持 HTTP Responses；当前供应商启用了其他协议或 WebSocket。');
    const upstream=safeBase(provider.baseUrl);
    syncResponsesCompatRuntime(bundleDir);
    const route={providerId,codexHome:codexHome||home(),upstream,originalBaseUrl:provider.baseUrl,token:randomBytes(24).toString('hex'),
      ...(desktopPipePath?{restartRequiredForPipe:desktopPipePath}:{})};
    writeJson('responses-compat.json',{...previous,instanceId:previous.instanceId||randomBytes(24).toString('hex'),routes:[...(previous.routes||[]),route],
      disabledProviders:(previous.disabledProviders||[]).filter(id=>id!==providerId)});
    try {
      const status=await ensure();const next=readJson('responses-compat.json',{});
      route.baseUrl=`http://127.0.0.1:${status.port}/${route.token}`;
      writeJson('responses-compat.json',{...next,port:status.port,routes:next.routes.map(r=>r.providerId===providerId?route:r)});
      await startup(true);
      await config({action:'update',providerId,expected:provider.baseUrl,replacement:route.baseUrl,backupPath:backup()});
      return responsesCompatStatus();
    }catch(error){writeJson('responses-compat.json',previous);if(!previous.routes?.length)await startup(false);throw error;}
  });
}
export async function prepareNewThreadCompat({bundleDir,desktopPipePath,config=providerConfig,
  configure=configureResponsesCompat,ensure=ensureResponsesCompat}={}) {
  const catalog=await config({action:'list'});
  const provider=catalog.providers.find(p=>p.id===catalog.activeProvider);
  if(!provider)return;
  const saved=readJson('responses-compat.json',{});
  if(saved.disabledProviders?.includes(provider.id))return;
  let route=saved.routes?.find(r=>r.providerId===provider.id);
  if(!route) {
    // Preserve native behavior for built-in/local or WebSocket providers.
    if(provider.wireApi!=='responses' || provider.supportsWebsockets || !provider.baseUrl.startsWith('https://'))return;
    await configure({providerId:provider.id,enabled:true},{bundleDir,desktopPipePath,config});
    // Loaded desktop configurations can retain their old endpoint. Never start
    // a first turn with that stale configuration or silently replay it later.
    throw Object.assign(new Error('已为当前第三方供应商启用本机 Responses 兼容。请重启 Codex 桌面后，再重新发送新建请求。本次尚未创建会话、尚未发送任务。'),{notSent:true});
  }
  if(provider.baseUrl!==route.baseUrl)throw Object.assign(new Error('当前供应商地址已更改，请先关闭旧的 Responses 兼容设置，再重新启用。本次尚未创建会话。'),{notSent:true});
  if(route.restartRequiredForPipe && route.restartRequiredForPipe===desktopPipePath)
    throw Object.assign(new Error('Responses 兼容已就绪，但桌面仍在使用启用前的连接。请重启 Codex 后重新发送新建请求。本次尚未创建会话、尚未发送任务。'),{notSent:true});
  await ensure();
}
