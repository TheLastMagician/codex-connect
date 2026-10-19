import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readConfig,providerList,requireSelection,discoverModels,home,launcherDefaults} from './providers.mjs';
import {withAppServer} from './app-server.mjs';
import {DesktopReader} from './desktop-ipc.mjs';
import {listProjects,projectDirectory} from './projects.mjs';

export const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function openThread(threadId) {
  if(!UUID.test(threadId))throw new Error('无效的会话 ID。');
  const url=`codex://threads/${threadId}`;
  const [bin,args]=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:
    process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{windowsHide:true,stdio:'ignore'});
    child.once('error',()=>reject(new Error('无法打开 Codex，请使用返回的会话链接。')));
    child.once('exit',code=>code===0?resolve():reject(new Error('桌面未确认打开操作，请使用会话链接。')));
  });
}
export async function confirmDesktop(thread,{open=openThread,Reader=DesktopReader,readThread=id=>withAppServer(async c=>(await c.request('thread/read',{threadId:id,includeTurns:false})).thread),timeoutMs=25000,pollMs=150,now=Date.now,sleep=delay}={}) {
  const stored=await readThread(thread.threadId);
  if(stored?.id!==thread.threadId||stored.modelProvider!==thread.providerId)throw new Error('会话保存的供应商与选择不一致，桌面设置未修改。');
  await open(thread.threadId);
  const reader=new Reader();
  try {
    await reader.connect();
    const deadline=now()+timeoutMs;
    do {
      const settings=await reader.settings(thread.threadId);
      if(settings?.resumeState==='resumed'){
        const observed=await reader.setModel(thread.threadId,thread.providerId,thread.model,thread.effort,
          {verifiedStoredProvider:stored.modelProvider,settleMs:Math.max(0,deadline-now()),pollMs,now,sleep});
        const {note,...confirmed}=thread;
        return {...confirmed,status:'settings_verified',observed};
      }
      await sleep(pollMs);
    }while(now()<deadline);
    throw new Error('会话已经创建，桌面尚未完成加载。点击“打开并确认”继续，不会重复创建。');
  }finally{reader.close();}
}

export class LauncherService {
  constructor({read=readConfig,rpc=withAppServer,confirm=confirmDesktop,stateDir=path.join(home(),'model-switcher')}={}) {
    Object.assign(this,{read,rpc,confirm,stateDir});this.inFlight=new Map();
  }
  stateFile(id){if(!UUID.test(id))throw new Error('无效的操作 ID。');return path.join(this.stateDir,'operations',id+'.json');}
  receipt(id){try{return JSON.parse(fs.readFileSync(this.stateFile(id),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('新建记录无法读取，请检查本机状态文件。');}}
  claim(id,value){fs.mkdirSync(path.dirname(this.stateFile(id)),{recursive:true,mode:0o700});try{fs.writeFileSync(this.stateFile(id),JSON.stringify(value),{flag:'wx',mode:0o600});return null;}catch(error){if(error.code==='EEXIST')return this.receipt(id);throw error;}}
  save(id,value){const file=this.stateFile(id),tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
  async catalog(extra={}) {
    const config=this.read();
    let turn=extra._meta?.['x-codex-turn-metadata'];
    if(typeof turn==='string'){try{turn=JSON.parse(turn);}catch{turn=null;}}
    const threadId=turn?.thread_id||extra._meta?.['openai/threadId']||process.env.CODEX_THREAD_ID;
    const {projects,thread}=await this.rpc(async c=>{
      const projects=await listProjects(c);let thread;
      if(threadId&&UUID.test(threadId))try{thread=(await c.request('thread/read',{threadId,includeTurns:false})).thread;}catch{}
      return {projects,thread};
    });
    return {...providerList(config),launcherDefaults:launcherDefaults(config),projects,defaultProjectId:thread?.projectId||projects.find(p=>p.roots.includes(thread?.cwd))?.id||null,defaultCwd:thread?.cwd||null,
      nativeCatalogConfigured:typeof config.model_catalog_json==='string',
      note:'选择项目后即可新建会话。'};
  }
  projects(){return this.rpc(client=>listProjects(client));}
  async models(providerId) {
    const config=this.read();
    return providerId==='openai'?this.rpc(client=>discoverModels(config,providerId,{client})):discoverModels(config,providerId);
  }
  create(args) {
    const {operationId}=args;
    if(!UUID.test(operationId||''))throw new Error('缺少有效的新建操作 ID。');
    const signature=JSON.stringify([args.providerId,args.model,args.projectId,args.cwd,args.title,args.effort||'none']);
    const running=this.inFlight.get(operationId);
    if(running){if(running.signature!==signature)throw new Error('同一个操作 ID 不能对应不同的供应商或模型。');return running.task;}
    const task=this.createOnce(args).finally(()=>this.inFlight.delete(operationId));
    this.inFlight.set(operationId,{task,signature});return task;
  }
  async createOnce({operationId,providerId,model,projectId,cwd,title,effort='none'}) {
    const selection=requireSelection(this.read(),providerId,model);
    if(!UUID.test(projectId||''))throw new Error('请选择 Codex 已有项目。');
    if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('请选择项目中的工作目录。');
    if(typeof title!=='string'||!title.trim()||title.length>100)throw new Error('会话标题需要 1–100 个字符。');
    if(!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw new Error('无效的思考强度。');
    const fingerprint=JSON.stringify([providerId,selection.model,projectId,path.resolve(cwd),title.trim(),effort]);
    const previous=this.receipt(operationId);
    if(previous){
      if(previous.fingerprint!==fingerprint)throw new Error('同一个操作 ID 不能对应不同的供应商或模型。');
      if(previous.threadId)return previous;
      throw new Error('这次新建的结果尚未确认，请检查 Codex 会话列表；为避免重复创建，未自动重试。');
    }
    let created;
    try {
      created=await this.rpc(async client=>{
        const {project}=await client.request('project/read',{projectId});
        cwd=projectDirectory(project,cwd);
        const claimed=this.claim(operationId,{status:'creating',fingerprint,startedAt:Date.now()});
        if(claimed){
          if(claimed.fingerprint!==fingerprint)throw new Error('同一个操作 ID 不能对应不同的设置。');
          if(claimed.threadId)return claimed;
          throw new Error('新建结果尚未确认，为避免重复创建，未自动重试。');
        }
        const result=await client.request('thread/start',{...selection,projectId,cwd,ephemeral:false,
          config:{model_reasoning_effort:effort,...(providerId!=='openai'?{web_search:'disabled'}:{})}});
        const threadId=result.thread.id;
        if(!UUID.test(threadId))throw new Error('Codex 返回了无法识别的会话 ID。');
        const record={operationId,threadId,providerId,model:selection.model,effort,projectId,projectName:project.name,cwd,title:title.trim(),
          url:`codex://threads/${threadId}`,fingerprint,status:'created',createdAt:Date.now()};
        this.save(operationId,record);
        await client.request('thread/name/set',{threadId,name:title.trim()});
        const readback=(await client.request('thread/read',{threadId,includeTurns:false})).thread;
        if(readback.projectId!==projectId||path.resolve(readback.cwd)!==cwd)throw new Error('会话已创建，但项目归属读回不一致。');
        record.projectVerified=true;this.save(operationId,record);
        return record;
      });
    }catch(error){
      const saved=this.receipt(operationId);
      if(saved?.threadId)return {...saved,note:'会话已创建，标题或后续设置尚未确认。请点击“打开并确认”。'};
      throw error;
    }
    return this.finish(created);
  }
  async complete(operationId) {
    if(!UUID.test(operationId||''))throw new Error('无效的操作 ID。');
    const saved=this.receipt(operationId);
    if(!saved?.threadId)throw new Error('没有找到已创建的会话，请刷新。');
    return this.finish(saved);
  }
  async finish(saved) {
    let result;
    try{
      if(saved.projectId&&!saved.projectVerified){
        const thread=await this.rpc(async c=>(await c.request('thread/read',{threadId:saved.threadId,includeTurns:false})).thread);
        if(thread.projectId!==saved.projectId||path.resolve(thread.cwd)!==path.resolve(saved.cwd))throw new Error('项目归属读回不一致，请检查该会话。');
        saved={...saved,projectVerified:true};
      }
      result=await this.confirm(saved,{readThread:id=>this.rpc(async c=>(await c.request('thread/read',{threadId:id,includeTurns:false})).thread)});
    }catch(error){result={...saved,status:'needs_confirmation',note:error.message};}
    this.save(saved.operationId,result);return result;
  }
}
