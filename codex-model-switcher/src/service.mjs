import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createInterface} from 'node:readline';
import {readConfig,providerList,requireSelection,discoverModels,home,launcherDefaults} from './providers.mjs';
import {withAppServer} from './app-server.mjs';
import {DesktopReader} from './desktop-ipc.mjs';
import {listProjects,projectDirectory} from './projects.mjs';

export const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function existingThreadId(reference) {
  if(typeof reference!=='string')throw new Error('请选择已有会话，或粘贴 codex://threads/ 会话链接。');
  const id=reference.trim().replace(/^codex:\/\/threads\//i,'');
  if(!UUID.test(id))throw new Error('会话链接或 ID 无效，请粘贴完整的 codex://threads/ 链接。');
  return id.toLowerCase();
}
export async function historyModel(thread) {
  if(typeof thread.path!=='string')return {status:'unavailable'};
  let input,lines;
  try{
    const size=fs.statSync(thread.path).size;
    if(size>128*1024*1024)return {status:'unavailable'};
    input=fs.createReadStream(thread.path,{encoding:'utf8',signal:AbortSignal.timeout(5000)});
    lines=createInterface({input,crlfDelay:Infinity});
    let model=null;
    for await(const line of lines){
      if(!/"type"\s*:\s*"turn_context"/.test(line))continue;
      let record;try{record=JSON.parse(line);}catch{continue;}
      if(record.type==='turn_context'&&typeof record.payload?.model==='string'&&record.payload.model.length<=160)model=record.payload.model;
    }
    return model?{status:'recorded',model}:{status:'empty'};
  }catch{return {status:'unavailable'};}
  finally{lines?.close();input?.destroy();}
}
export function continuationCheck(history,model) {
  const requiresContextReview=history.status==='recorded'&&history.model!==model;
  const note=requiresContextReview
    ?`模型设置已读回为 ${model}，但历史上下文模型仍是 ${history.model}。Codex 发送前可能先调用旧模型压缩；旧模型不可用时会阻断回复。请在原会话先执行 /compact，等当前模型压缩完成后再发送。此操作只验证设置，未验证普通消息请求。`
    :history.status==='recorded'
      ?'模型设置和历史上下文模型一致；只完成设置核对，尚未验证下一条普通消息请求。'
      :'模型设置已读回，但历史上下文模型暂无法核对；发送时仍可能触发压缩。此操作未发送验证消息。';
  return {history,requiresContextReview,verificationScope:'settings_only',note};
}
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
    throw new Error('桌面尚未完成加载，请重新打开并确认该会话。');
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
      currentThread:thread?{id:thread.id,title:thread.name||thread.title||'未命名会话',providerId:thread.modelProvider}:null,
      nativeCatalogConfigured:typeof config.model_catalog_json==='string',
      note:'可以新建会话，或修改已有会话的模型。'};
  }
  async existingThreads({providerId='custom',cursor}={}) {
    requireSelection(this.read(),providerId,'discovery');
    if(cursor!=null&&(typeof cursor!=='string'||cursor.length>4096))throw new Error('无效的分页位置，请刷新会话列表。');
    return this.rpc(async c=>{
      const page=await c.request('thread/list',{limit:100,archived:false,sortKey:'updated_at',modelProviders:[providerId],...(cursor?{cursor}:{})});
      return {threads:(page.data||[]).filter(t=>UUID.test(t.id)&&t.modelProvider===providerId).map(t=>({
        id:t.id,title:t.name||t.title||t.preview?.slice(0,80)||'未命名会话',providerId:t.modelProvider,cwd:t.cwd,updatedAt:t.updatedAt
      })),nextCursor:page.nextCursor||null,providerId};
    });
  }
  async modifyExisting({threadRef,providerId='custom',model='qwen3.8-27b',effort='xhigh'}) {
    const threadId=existingThreadId(threadRef),selection=requireSelection(this.read(),providerId,model);
    if(!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw new Error('无效的思考强度。');
    const readThread=id=>this.rpc(async c=>(await c.request('thread/read',{threadId:id,includeTurns:false})).thread);
    const thread=await readThread(threadId);
    if(thread?.id!==threadId)throw new Error('没有找到所选会话。');
    if(thread.modelProvider!==providerId)throw new Error(`该会话的供应商是 ${thread.modelProvider||'未知'}，与 ${providerId} 不一致。请选择原供应商的会话；此操作不切换供应商。`);
    if(thread.status?.type==='active')throw new Error('该会话正在运行，请等待当前回复完成后再修改。');
    const record={threadId,providerId,model:selection.model,effort,title:thread.name||thread.title||'已有会话',cwd:thread.cwd,url:`codex://threads/${threadId}`};
    try{
      const confirmed=await this.confirm(record,{readThread});
      const history=await historyModel(thread);
      return {...confirmed,action:'modified',...continuationCheck(history,selection.model)};
    }
    catch(error){return {...record,action:'modified',status:'needs_confirmation',note:`修改结果尚未确认：${error.message} 请对同一会话重试并读回设置。`};}
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
