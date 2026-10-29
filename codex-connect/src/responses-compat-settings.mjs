import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
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
    note:saved.routes?.length
      ?'旧版全局兼容仍在运行，会影响该供应商的所有会话。请关闭兼容以恢复原地址，之后重启 Codex。'
      :'未启用全局兼容。插件不修改供应商地址，新建及已有会话均交由桌面原有连接执行。'};
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
export async function configureResponsesCompat({providerId,enabled},{
  config:configOverride,codexHome,startup=setCompatStartup}={}) {
  if(typeof enabled!=='boolean' || typeof providerId!=='string' || !providerId)throw new Error('需要真实供应商 ID 和 enabled。');
  // A provider-wide proxy cannot be scoped to a new chat or its first request.
  // Keep only the recovery path for installations that enabled it in 0.4.1.
  if(enabled)throw new Error('已停用全局 Responses 兼容；它会影响这个供应商的所有会话，无法仅作用于新建。现仅支持 enabled=false 恢复原地址。');
  return lock('responses-compat-config.lock',async()=>{
    const previous=readJson('responses-compat.json',{}),existing=previous.routes?.find(r=>r.providerId===providerId);
    const config=configOverride||(request=>providerConfig(request,{codexHome:existing?.codexHome||codexHome||home()}));
    const catalog=await config({action:'list'}),provider=catalog.providers.find(p=>p.id===providerId);
    if(!provider)throw new Error('未找到这个已配置的供应商。');
    const backup=()=>path.join(dataDir,'provider-backups',`${Date.now()}-${randomUUID()}.toml`);
    if(existing && provider.baseUrl===existing.baseUrl)await config({action:'update',providerId,expected:existing.baseUrl,replacement:existing.originalBaseUrl,backupPath:backup()});
    const next={...previous,routes:(previous.routes||[]).filter(r=>r.providerId!==providerId),
      disabledProviders:[...new Set([...(previous.disabledProviders||[]),providerId])]};
    writeJson('responses-compat.json',next);if(!next.routes.length)await startup(false);
    return responsesCompatStatus();
  });
}
