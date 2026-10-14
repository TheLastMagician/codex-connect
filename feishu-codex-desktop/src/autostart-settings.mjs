import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {dataDir,secureDirectory,readJson,writeJson} from './storage.mjs';
import {VERSION} from './version.mjs';

const runtimeDir=path.join(dataDir,'runtime');
export const autostartEntry=()=>path.join(runtimeDir,'autostart.cjs');
function hooksPath(codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')) {return path.join(codexHome,'hooks.json');}
function readHooks(file) {
  try {
    const parsed=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) ||
      (parsed.hooks!==undefined && (!parsed.hooks || typeof parsed.hooks!=='object' || Array.isArray(parsed.hooks))) ||
      (parsed.hooks?.SessionStart!==undefined && (!Array.isArray(parsed.hooks.SessionStart) ||
        parsed.hooks.SessionStart.some(group=>!group || typeof group!=='object' || !Array.isArray(group.hooks)))))throw new Error('shape');
    return parsed;
  }catch(error){if(error.code==='ENOENT')return {};throw new Error('现有 hooks.json 无法读取，未修改自动启动设置。');}
}
function atomicWrite(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try {fs.writeFileSync(temp,data,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
  finally{try{fs.unlinkSync(temp);}catch{}}
}
export function autostartStatus({codexHome}={}) {
  const saved=readJson('autostart.json',{});
  let hookRegistered=false;
  try{hookRegistered=!!saved.command && (readHooks(hooksPath(codexHome)).hooks?.SessionStart||[])
    .some(group=>group.hooks?.some(hook=>hook.type==='command' && hook.command===saved.command));}catch{}
  const context=readJson('desktop-context.json',{}),pause=readJson('autostart-pause.json',{});
  return {enabled:saved.enabled===true,hookRegistered,runtimeVersion:saved.runtimeVersion||null,
    pausedForCurrentDesktop:!!context.pipePath && pause.pipePath===context.pipePath,
    requiresHookTrust:saved.enabled===true,
    note:'首次需在 Codex 设置的钩子页审阅并信任一次（CLI 可用 /hooks）；启动或恢复桌面会话时自动连接，无需发送启动指令。'};
}
export function syncAutostartRuntime(bundleDir) {
  const required=['autostart.cjs','bridge.cjs','catalog.py'];
  if(!bundleDir || required.some(name=>!fs.existsSync(path.join(bundleDir,name))))throw new Error('缺少自动启动组件，请更新插件后重试。');
  secureDirectory();
  for(const name of [...required,'autostart.cjs.LEGAL.txt','bridge.cjs.LEGAL.txt']) {
    const source=path.join(bundleDir,name);
    if(fs.existsSync(source))atomicWrite(path.join(runtimeDir,name),fs.readFileSync(source));
  }
  const saved=readJson('autostart.json',{});
  if(saved.enabled===true && saved.runtimeVersion!==VERSION)writeJson('autostart.json',{...saved,runtimeVersion:VERSION});
}
export function configureAutostart(enabled,{bundleDir,codexHome}={}) {
  if(typeof enabled!=='boolean')throw new Error('enabled 必须为 true 或 false');
  const file=hooksPath(codexHome),hooks=readHooks(file),previous=readJson('autostart.json',{});
  const command=`node "${autostartEntry()}"`;
  if(/["\r\n\0]/.test(autostartEntry()))throw new Error('自动启动路径包含不支持的字符');
  const commands=new Set([command,previous.command].filter(Boolean));
  const groups=(hooks.hooks?.SessionStart||[]).flatMap(group=>{
    const filtered=group.hooks.filter(hook=>!(hook.type==='command' && commands.has(hook.command)));
    return group.hooks.length && !filtered.length?[]:[{...group,hooks:filtered}];
  });
  if(enabled) {
    syncAutostartRuntime(bundleDir);
    groups.push({matcher:'^(startup|resume|clear|fork)$',hooks:[{type:'command',command,timeout:15,statusMessage:'连接 Codex 桌面聊天通道'}]});
  }
  atomicWrite(file,JSON.stringify({...hooks,hooks:{...hooks.hooks,SessionStart:groups}},null,2)+'\n');
  writeJson('autostart.json',{enabled,command,runtimeVersion:enabled?VERSION:previous.runtimeVersion||null});
  if(enabled)writeJson('autostart-pause.json',{});
  return autostartStatus({codexHome});
}
