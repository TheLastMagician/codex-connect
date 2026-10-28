import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {home,readConfig,requireSelection} from './providers.mjs';
import {withAppServer} from './app-server.mjs';
import {DesktopReader} from './desktop-ipc.mjs';
import {persistProviderSwitch} from './provider-switch.mjs';
import {spawn} from 'node:child_process';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export class ProviderChangeStore {
  constructor({directory=path.join(home(),'model-switcher','provider-changes')}={}){this.directory=directory;}
  file(id){if(!UUID.test(id||''))throw new Error('无效的会话 ID。');return path.join(this.directory,id+'.json');}
  get(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  list(){if(!fs.existsSync(this.directory))return[];return fs.readdirSync(this.directory).filter(n=>/^[\da-f-]+\.json$/i.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(this.directory,n),'utf8'))).sort((a,b)=>b.updatedAt-a.updatedAt);}
  write(job){fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const file=this.file(job.threadId),temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify({...job,updatedAt:Date.now()}),{mode:0o600});fs.renameSync(temp,file);return this.get(job.threadId);}
  locked(id,action){
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const file=this.file(id)+'.lock';let fd;
    for(let i=0;i<2;i++){
      try{fd=fs.openSync(file,'wx',0o600);break;}catch(error){
        if(error.code!=='EEXIST')throw error;
        let stale=false;try{const pid=Number(fs.readFileSync(file,'utf8'));if(pid>0){try{process.kill(pid,0);}catch(e){stale=e.code==='ESRCH';}}else stale=Date.now()-fs.statSync(file).mtimeMs>30000;}catch{}
        if(stale){try{fs.unlinkSync(file);}catch{}continue;}
        const busy=new Error('供应商切换记录正在更新，请稍后重试。');busy.code='PROVIDER_QUEUE_BUSY';throw busy;
      }
    }
    if(fd===undefined){const busy=new Error('供应商切换记录正在更新，请稍后重试。');busy.code='PROVIDER_QUEUE_BUSY';throw busy;}
    try{fs.writeFileSync(fd,String(process.pid));return action();}finally{fs.closeSync(fd);fs.unlinkSync(file);}
  }
  transition(id,operationId,statuses,patch){return this.locked(id,()=>{const job=this.get(id);return job?.id===operationId&&statuses.includes(job.status)?this.write({...job,...patch}):null;});}
  enqueue(thread,selection,effort){
    return this.locked(thread.id,()=>{
    const old=this.get(thread.id);
    if(old?.status==='applying')throw new Error('该会话正在切换供应商，请等待后台完成后再修改。');
    if(old?.status==='waiting'&&old.providerId===selection.modelProvider&&old.model===selection.model&&old.effort===effort)return old;
    return this.write({id:randomUUID(),threadId:thread.id,title:thread.name||thread.title||'已有会话',sourceProvider:thread.modelProvider,providerId:selection.modelProvider,model:selection.model,effort,cwd:thread.cwd,projectId:thread.projectId,status:'waiting',attempts:0,createdAt:Date.now(),note:'等待原会话释放。请完全退出 Codex，后台保存完成后会自动打开原会话。'});
    });
  }
  cancel(id){return this.locked(id,()=>{const job=this.get(id);if(!job||job.status!=='waiting')throw new Error('仅等待中的切换可以取消。');return this.write({...job,status:'cancelled',note:'已取消，未继续切换。'});});}
}
async function desktopHasThread(id){const reader=new DesktopReader({timeoutMs:2000});try{await reader.connect();return !!await reader.settings(id);}catch{return false;}finally{reader.close();}}
async function reopenThread(id){
  if(!UUID.test(id))throw new Error('无效的会话 ID。');const url=`codex://threads/${id}`;
  const [command,args]=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('无法自动打开原会话。')));});
}
export async function processProviderChanges(store,{rpc=withAppServer,read=readConfig,isLoaded=desktopHasThread,persist=persistProviderSwitch,open=reopenThread}={}){
  for(const job of store.list().filter(j=>['waiting','applying'].includes(j.status))){
    if(await isLoaded(job.threadId))continue;
    let current=store.get(job.threadId);if(current.id!==job.id||!['waiting','applying'].includes(current.status))continue;
    try{
      const selection=requireSelection(read(),job.providerId,job.model);
      const thread=await rpc(async c=>(await c.request('thread/read',{threadId:job.threadId,includeTurns:false})).thread);
      if(thread.id!==job.threadId||thread.cwd!==job.cwd||thread.projectId!==job.projectId||![job.sourceProvider,job.providerId].includes(thread.modelProvider))throw new Error('会话身份、目录、项目或供应商已变化，切换已停止，请刷新后重新设置。');
      current=store.get(job.threadId);if(current.id!==job.id||!['waiting','applying'].includes(current.status))continue;
      if(!store.transition(job.threadId,job.id,['waiting','applying'],{status:'applying',note:'正在保存并用新进程核对供应商。'}))continue;
      await persist(thread,selection,job.effort,{rpc});
      if(!store.transition(job.threadId,job.id,['applying'],{status:'saved',note:'新进程已核对供应商、模型与强度，正在打开原会话。历史模型不同时，先执行 /compact 再发送。'}))continue;
      try{await open(job.threadId);store.transition(job.threadId,job.id,['saved'],{note:'新供应商、模型与强度已保存并核对，已请求打开原会话。首次发送前请核对设置；历史模型不同时先执行 /compact。'});}catch{store.transition(job.threadId,job.id,['saved'],{note:'新供应商、模型与强度已保存并核对。自动打开失败，请手动打开原会话；历史模型不同时先执行 /compact。'});}
    }catch(error){
      if(error.code==='PROVIDER_QUEUE_BUSY')continue;
      const locked=error.code==='THREAD_WRITER_ACTIVE',attempts=job.attempts+(locked?0:1);
      store.transition(job.threadId,job.id,['waiting','applying'],{status:locked||attempts<5?'waiting':'failed',attempts,note:locked?'原会话写锁尚未释放，请完全退出 Codex 后等待后台完成。':`切换尚未核对：${error.message}。若已重新打开 Codex，请等待下次释放会话后重试。`});
    }
  }
}
