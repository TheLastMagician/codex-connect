import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopClient} from './desktop.mjs';
import {dataDir,secureDirectory,config,readJson,writeJson} from './storage.mjs';
import {readWechatAccount} from './wechat-storage.mjs';

export function alive(pid) {
  if(!Number.isInteger(pid) || pid<=0)return false;
  try {process.kill(pid,0);return true;}catch{return false;}
}
function readLock(name) {try{return readJson(name,{});}catch(error){if(error instanceof SyntaxError)return {};throw error;}}
export function desktopContext(extra,{env=process.env,event={},saved=readJson('desktop-context.json',{})}={}) {
  const meta=extra?._meta||{};let turn=meta['x-codex-turn-metadata'];
  if(typeof turn==='string'){try{turn=JSON.parse(turn);}catch{turn={};}}
  const threadId=turn?.thread_id || meta['openai/threadId'] || meta.threadId || event.session_id || env.CODEX_THREAD_ID || saved.threadId;
  const pipePath=env.CODEX_APP_TOOLS_PIPE_PATH || saved.pipePath;
  if(typeof threadId!=='string' || !threadId || typeof pipePath!=='string' || !pipePath)
    throw new Error('缺少真实桌面连接；请在 Codex 桌面恢复一个会话后重试。');
  return {pipePath,threadId};
}
export function hasConfiguredChannel() {
  const settings=config(),wechat=readWechatAccount(),login=readJson('wechat-login.json',{});
  return !!(settings.appId && settings.appSecret && settings.feishuEnabled!==false) ||
    !!(wechat.enabled && wechat.token && wechat.botId && wechat.ownerUserId) ||
    (['wait','scaned','need_verifycode'].includes(login.status) && login.expiresAt>Date.now());
}
export async function validateDesktopContext(context) {
  const desktop=new DesktopClient(context);
  try {await desktop.call('list_threads',{limit:1});return desktop.context;}finally{desktop.close();}
}
export function pauseAutostart() {
  const saved=readJson('desktop-context.json',{});
  writeJson('autostart-pause.json',{pipePath:saved.pipePath||null});
}
function automaticSkip(context) {
  if(readJson('autostart.json',{}).enabled!==true)return 'disabled';
  if(readJson('autostart-pause.json',{}).pipePath===context.pipePath)return 'paused';
  if(!hasConfiguredChannel())return 'not_configured';
}
export async function ensureBridge(context,{entryPath,automatic=false,validate=validateDesktopContext}={}) {
  const skipped=automatic && automaticSkip(context);if(skipped)return {skipped};
  if(!hasConfiguredChannel()) {
    if(automatic)return {skipped:'not_configured'};
    throw new Error('请先配置飞书，或扫码连接微信。');
  }
  secureDirectory();
  const lockPath=path.join(dataDir,'bridge-start.lock');let lock;
  const deadline=Date.now()+6000;
  while(lock===undefined) {
    try {
      lock=fs.openSync(lockPath,'wx',0o600);
      fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
    }catch(error) {
      if(error.code!=='EEXIST')throw error;
      const owner=readLock('bridge-start.lock');
      if(owner.pid && !alive(owner.pid)){try{fs.unlinkSync(lockPath);}catch{}continue;}
      if(Date.now()>=deadline)throw new Error('另一个启动操作尚未完成，请稍后检查桥接状态。');
      await delay(50);
    }
  }
  try {
    // Verify the host-supplied context before publishing it to a running bridge.
    context=await validate(context)||context;
    const skipped=automatic && automaticSkip(context);if(skipped)return {skipped};
    writeJson('desktop-context.json',context);
    if(!automatic)writeJson('autostart-pause.json',{});
    const previous=readJson('status.json',{}),running=readLock('bridge.lock');
    if(alive(running.pid))return {alreadyRunning:true,pid:running.pid,state:previous.state||'starting'};
    if(!entryPath || !fs.existsSync(entryPath))throw new Error('缺少桥接运行文件，请更新插件后重试。');
    const log=fs.openSync(path.join(dataDir,'bridge.log'),'a',0o600);
    let child;
    try {
      child=spawn(process.execPath,[entryPath],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:process.env});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    }finally{fs.closeSync(log);}
    // Hold the start lock until the child has claimed the bridge lock. Concurrent
    // session hooks and MCP processes must not launch competing channel clients.
    const readyBy=Date.now()+3000;
    while(Date.now()<readyBy && alive(child.pid)) {
      if(readLock('bridge.lock').pid===child.pid)return {startedProcess:true,pid:child.pid,note:'桥接已启动，请查看通道连接状态。'};
      await delay(50);
    }
    throw new Error('桥接未能确认启动，请查看桥接状态。');
  }finally{fs.closeSync(lock);try{fs.unlinkSync(lockPath);}catch{}}
}
