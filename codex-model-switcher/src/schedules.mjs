import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {home,readConfig,requireSelection} from './providers.mjs';
import {existingThreadId,UUID} from './service.mjs';
import {withAppServer} from './app-server.mjs';

export const SCHEDULER_VERSION='0.4.0';
export const GRACE_MS=15*60*1000;
export const scheduleDirectory=()=>path.join(home(),'model-switcher','scheduler');
export function localDay(now){return new Date(now+8*3600000).toISOString().slice(0,10);}
export function scheduledTime(job,day){return Date.parse(`${day}T${job.time}:00+08:00`);}
const ALL_DAYS=[1,2,3,4,5,6,7];
export function scheduleDays(job){
  if(!job.frequency||job.frequency==='daily')return ALL_DAYS;
  if(job.frequency!=='weekly'||!Array.isArray(job.weekdays)||!job.weekdays.length||job.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7))throw new Error('每周计划至少选择一个有效的星期（1=周一，7=周日）。');
  return [...new Set(job.weekdays)].sort((a,b)=>a-b);
}
export function runsOnDay(job,day){return scheduleDays(job).includes(new Date(`${day}T12:00:00+08:00`).getUTCDay()||7);}
export function previousScheduledDay(job,now){
  for(let offset=1;offset<=7;offset++){const day=localDay(now-offset*86400000);if(runsOnDay(job,day))return day;}
}
export function nextRun(job,now=Date.now()){
  if(job.status!=='ACTIVE')return null;
  for(let offset=0;offset<=7;offset++){
    const day=localDay(now+offset*86400000),at=scheduledTime(job,day);
    if(at>now&&runsOnDay(job,day))return at;
  }
  return null;
}
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);
}
export class ScheduleStore {
  constructor({directory=scheduleDirectory(),read=readConfig,rpc=withAppServer,now=Date.now}={}){Object.assign(this,{directory,read,rpc,now});}
  jobFile(id){if(!UUID.test(id||''))throw new Error('无效的定时任务 ID。');return path.join(this.directory,'jobs',id+'.json');}
  readJob(id){try{return JSON.parse(fs.readFileSync(this.jobFile(id),'utf8'));}catch(error){if(error.code==='ENOENT')throw new Error('定时任务不存在，请刷新列表。');throw error;}}
  jobs(){const folder=path.join(this.directory,'jobs');if(!fs.existsSync(folder))return[];return fs.readdirSync(folder).filter(f=>/^[\da-f-]+\.json$/i.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(folder,f),'utf8')));}
  runFile(id,day){this.jobFile(id);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('无效的运行日期。');return path.join(this.directory,'runs',id,day+'.json');}
  run(id,day){try{return JSON.parse(fs.readFileSync(this.runFile(id,day),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  claim(job,day){const file=this.runFile(job.id,day);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const run={jobId:job.id,day,scheduledFor:scheduledTime(job,day),status:'waiting',clientUserMessageId:randomUUID(),createdAt:this.now(),updatedAt:this.now()};try{fs.writeFileSync(file,JSON.stringify(run),{flag:'wx',mode:0o600});return run;}catch(e){if(e.code==='EEXIST')return this.run(job.id,day);throw e;}}
  saveRun(run){atomicJson(this.runFile(run.jobId,run.day),{...run,updatedAt:this.now()});}
  recent(id){const folder=path.join(this.directory,'runs',id);if(!fs.existsSync(folder))return[];return fs.readdirSync(folder).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0,7).map(f=>JSON.parse(fs.readFileSync(path.join(folder,f),'utf8')));}
  pending(id){const folder=path.join(this.directory,'runs',id);if(!fs.existsSync(folder))return[];return fs.readdirSync(folder).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(folder,f),'utf8'))).filter(r=>['accepted','submitting','unknown'].includes(r.status));}
  acknowledge(id,day){const run=this.run(id,day);if(!run||!['unknown','submitting'].includes(run.status)||this.now()-run.updatedAt<120000)throw new Error('该记录暂不能解除阻塞，请等待并核对原会话。');this.saveRun({...run,status:'reviewed',note:'用户已核对并解除阻塞；本次不会重发。'});return {acknowledged:true};}
  list(){return this.jobs().map(job=>({...job,nextRunAt:nextRun(job,this.now()),runs:[...new Map([...this.pending(job.id),...this.recent(job.id)].map(r=>[r.day,r])).values()].sort((a,b)=>b.day.localeCompare(a.day))}));}
  async save(input){
    const {id,name,threadRef,prompt,time,status='ACTIVE',providerId='custom',model='qwen3.8-27b',effort='xhigh'}=input;
    this.jobFile(id);const threadId=existingThreadId(threadRef),selection=requireSelection(this.read(),providerId,model);
    const old=fs.existsSync(this.jobFile(id))?this.readJob(id):null;
    const frequency=input.frequency??old?.frequency??'daily';
    if(!['daily','weekly'].includes(frequency))throw new Error('执行频率必须为每天或每周。');
    const weekdays=scheduleDays({frequency,weekdays:input.weekdays??(old?.frequency==='weekly'?old.weekdays:undefined)});
    if(typeof name!=='string'||!name.trim()||name.length>100)throw new Error('任务名称需要 1–100 个字符。');
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw new Error('任务提示词需要 1–12000 个字符。');
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time||''))throw new Error('请选择有效的执行时间。');
    if(!['ACTIVE','PAUSED'].includes(status)||!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw new Error('无效的任务状态或思考强度。');
    const thread=await this.rpc(async c=>(await c.request('thread/read',{threadId,includeTurns:false})).thread);
    if(thread?.id!==threadId||thread.modelProvider!==providerId)throw new Error('任务目标会话的供应商不一致，未保存。');
    if(status==='ACTIVE'&&this.jobs().some(j=>j.id!==id&&j.status==='ACTIVE'&&j.threadId===threadId&&j.time===time&&j.prompt===prompt.trim()&&scheduleDays(j).some(d=>weekdays.includes(d))))throw new Error('这个会话已有相同时间和提示词且执行日期重叠的启用任务，请编辑已有任务。');
    const job={id,name:name.trim(),threadId,title:thread.name||thread.title||name.trim(),prompt:prompt.trim(),time,frequency,weekdays,timeZone:'Asia/Shanghai',status,providerId,model:selection.model,effort,revision:randomUUID(),activeSince:this.now(),createdAt:old?.createdAt||this.now(),updatedAt:this.now()};
    atomicJson(this.jobFile(id),job);return {...job,nextRunAt:nextRun(job,this.now())};
  }
  setStatus(id,status){if(!['ACTIVE','PAUSED'].includes(status))throw new Error('无效的任务状态。');const job={...this.readJob(id),status,revision:randomUUID(),updatedAt:this.now()};atomicJson(this.jobFile(id),job);return job;}
}

// Persist the submitting marker before native I/O. Unknown outcomes are never replayed.
export async function tickSchedules(store,{now=Date.now(),dispatch,observe=async()=>null}={}){
  const day=localDay(now),jobs=store.jobs();
  for(const job of jobs){
    for(const old of store.recent(job.id).filter(r=>r.status==='waiting'&&now-r.scheduledFor>GRACE_MS))store.saveRun({...old,status:'missed',note:'等待窗口已结束，本次已跳过。'});
    for(const run of store.pending(job.id).filter(r=>r.status==='accepted')){
      try{const result=await observe(job,run);if(result){store.saveRun({...run,...result});if(result.status==='model_mismatch')store.setStatus(job.id,'PAUSED');}}catch{/* Keep accepted until a later observation succeeds. */}
    }
    const current=store.readJob(job.id);if(current.revision!==job.revision||current.status!=='ACTIVE')continue;
    const previousDay=previousScheduledDay(job,now),previousDue=scheduledTime(job,previousDay),activeSince=job.activeSince||job.createdAt;
    if(job.status==='ACTIVE'&&activeSince<previousDue&&!store.run(job.id,previousDay))store.saveRun({...store.claim(job,previousDay),status:'missed',note:'电脑或后台服务未在等待窗口内执行，本次已跳过，不会补跑。'});
    const due=scheduledTime(job,day);
    if(job.status!=='ACTIVE'||!runsOnDay(job,day)||now<due||activeSince>due)continue;
    let run=store.run(job.id,day);
    if(run&&run.status!=='waiting')continue;
    if(now-due>GRACE_MS){if(!run)run=store.claim(job,day);store.saveRun({...run,status:'missed',note:'超过 15 分钟等待窗口，已跳过；不会补跑旧任务。'});continue;}
    run??=store.claim(job,day);
    // A previous accepted/unknown run in this thread blocks another scheduled submission.
    const blocking=jobs.some(j=>j.threadId===job.threadId&&store.pending(j.id).length>0);
    if(blocking)continue;
    let submitted=false;
    const beforeSubmit=()=>{
      const fresh=store.readJob(job.id);
      if(fresh.status!=='ACTIVE'||fresh.revision!==job.revision||fresh.updatedAt!==job.updatedAt)throw new Error('任务已暂停或修改，本次尚未发送。');
      submitted=true;run={...run,status:'submitting',submittedAt:now};store.saveRun(run);
    };
    try{
      const result=await dispatch(job,run,beforeSubmit);
      if(!submitted)throw new Error('发送入口未持久化提交标记。');
      store.saveRun({...run,...result,status:result.turnId?'accepted':'unknown',note:result.turnId?'桌面已接收，等待运行完成。':'桌面未返回回合 ID，结果待核对；不会自动重发。'});
    }catch(error){store.saveRun({...run,status:submitted?'unknown':'waiting',note:submitted?'发送结果未知，请检查原会话；不会自动重发。':error.message});}
  }
}
