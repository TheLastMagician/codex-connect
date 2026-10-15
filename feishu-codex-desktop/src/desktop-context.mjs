import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
let discovery;
export function desktopUnavailable() {
  return Object.assign(new Error('Codex 桌面连接暂不可用，正在等待重新连接。本次操作尚未发送。请保持 Codex 运行，稍后重试。'),{code:'DESKTOP_DISCONNECTED',notSent:true});
}
export async function discoverDesktopEndpoints({platform=process.platform,script=path.join(directory,'discover-desktop.ps1')}={}) {
  if(platform!=='win32')return [];
  return new Promise(resolve=>{
    let source;try{source=fs.readFileSync(script,'utf8');}catch{return resolve([]);}
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','-'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let output='';const timer=setTimeout(()=>{child.kill();resolve([]);},15000);
    child.once('error',()=>{clearTimeout(timer);resolve([]);});
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();resolve([]);}});
    child.once('exit',code=>{
      clearTimeout(timer);
      try {
        const endpoints=JSON.parse(output.trim().replace(/^\uFEFF/,''));
        resolve(code===0 && Array.isArray(endpoints)?endpoints.filter(e=>typeof e.pipePath==='string' && /^\\\\\.\\pipe\\codex-browser-use-[0-9a-f-]{36}$/i.test(e.pipePath) && Number.isInteger(e.serverPid) && e.serverPid>0):[]);
      }catch{resolve([]);}
    });
    child.stdin.on('error',()=>{});child.stdin.end('& {\n'+source+'\n}\n\n');
  });
}
export async function recoverDesktopContext(current,{probe,discover=discoverDesktopEndpoints,read,publish}={}) {
  // Resolve storage only when recovery is actually needed. Importing the native
  // transport must not capture a data directory before its host config is set.
  if(!read || !publish) {
    const storage=await import('./storage.mjs');
    read ||= ()=>storage.readJson('desktop-context.json',{});
    publish ||= context=>storage.writeJson('desktop-context.json',context);
  }
  const saved=read();
  if(saved.pipePath && saved.threadId && saved.pipePath!==current.pipePath) {
    try {await probe(saved);return saved;}catch{}
  }
  // Discovery authenticates the server process; retain an actual host-provided
  // caller chat. Finding an endpoint never invents a source thread identity.
  const source=saved.threadId?saved:current;
  if(!source.threadId)throw desktopUnavailable();
  discovery ||= discover().finally(()=>{discovery=null;});
  const endpoints=await discovery;
  const candidates=endpoints.filter(e=>e.pipePath!==current.pipePath).slice(0,8)
    .map(e=>({pipePath:e.pipePath,threadId:source.threadId}));
  // The desktop owns other native pipes too. Only its actual codex_app tool
  // catalog and a successful read-only chat query establish a usable endpoint.
  const checked=await Promise.allSettled(candidates.map(async candidate=>{await probe(candidate);return candidate;}));
  const usable=checked.filter(result=>result.status==='fulfilled').map(result=>result.value);
  if(usable.length!==1)throw desktopUnavailable();
  const candidate=usable[0];
  // A newer host binding may have arrived during discovery. Verify and use it
  // rather than overwriting it with this recovery attempt's older snapshot.
  const latest=read();
  if(latest.pipePath && latest.threadId && (latest.pipePath!==saved.pipePath || latest.threadId!==saved.threadId)) {
    try{await probe(latest);return latest;}catch{}
  }
  publish(candidate);return candidate;
}
