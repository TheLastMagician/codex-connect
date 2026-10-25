import path from 'node:path';
import {spawn} from 'node:child_process';

const threadIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function threadWakeUrl(thread) {
  if((thread?.hostId||'local')!=='local' || !threadIdPattern.test(thread?.id||''))return null;
  return `codex://threads/${thread.id}`;
}
export async function openRegisteredThread(url,{platform=process.platform,launch=spawn}={}) {
  if(platform!=='win32' || !/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(url))throw new Error('无法唤起桌面会话');
  // Use the existing registered application link. No shell, renderer patches,
  // input text, separate app-server, or new conversation is involved.
  const child=launch(path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe'),[url],
    {windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
}
export class DesktopWake {
  constructor({platform=process.platform,open=openRegisteredThread,now=Date.now,cooldownMs=60000}={}) {
    Object.assign(this,{platform,open,now,cooldownMs});
  }
  async recover(thread,{authorize,beforeWake}={}) {
    const url=threadWakeUrl(thread);
    if(this.platform!=='win32' || !url || typeof authorize!=='function' || typeof beforeWake!=='function')return false;
    if(this.work){await this.work.catch(()=>{});return false;}
    if(this.lastAttempt && this.now()-this.lastAttempt.at<this.cooldownMs)return false;
    authorize();
    if(beforeWake()!==true)return false;
    this.lastAttempt={at:this.now(),state:'requested'};
    const work=Promise.resolve().then(async()=>{
      authorize();await this.open(url);return true;
    }).catch(()=>{this.lastAttempt={...this.lastAttempt,state:'failed'};return false;})
      .finally(()=>{if(this.work===work)this.work=null;});
    this.work=work;return work;
  }
}
