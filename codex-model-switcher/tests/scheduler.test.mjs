import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ScheduleStore,tickSchedules,nextRun,localDay,runsOnDay,GRACE_MS} from '../src/schedules.mjs';
import {scheduledTurnRequest,scheduledPreflight,dispatchScheduled,observeScheduled} from '../src/scheduled-turn.mjs';

const config={model_providers:{custom:{base_url:'https://gateway.example/v1',wire_api:'responses'}}};
const due=Date.parse('2026-10-20T23:00:00+08:00');
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-scheduler-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let now=due-3600000;const threadId=randomUUID(),turnId=randomUUID(),rollout=path.join(directory,'rollout.jsonl');
  const thread={id:threadId,name:'日报',modelProvider:'custom',path:rollout,status:{type:'notLoaded'}};
  fs.writeFileSync(rollout,JSON.stringify({type:'turn_context',payload:{turn_id:turnId,model:'qwen3.8-27b',effort:'xhigh'}})+'\n');
  const rpc=async action=>action({request:async method=>method==='thread/read'?{thread}:method==='thread/turns/list'?{data:[{id:turnId,status:'completed'}]}:assert.fail(method)});
  const store=new ScheduleStore({directory,read:()=>config,rpc,now:()=>now});
  const job=await store.save({id:randomUUID(),name:'日报',threadRef:threadId,prompt:'生成今日日报',time:'23:00',status:'ACTIVE'});
  return {store,job,rpc,thread,turnId,rollout,setNow:value=>{now=value;}};
}
test('daily schedule uses Beijing time independently of host timezone',()=>{
  const job={time:'23:00',status:'ACTIVE'};
  assert.equal(localDay(Date.parse('2026-10-20T23:00:00Z')),'2026-10-21');
  assert.equal(nextRun(job,due-1),due);assert.equal(nextRun(job,due),due+86400000);
  assert.equal(nextRun({...job,status:'PAUSED'},due),null);
});

test('weekly next run follows selected Beijing weekdays across weeks, months and years',()=>{
  const job={time:'09:30',status:'ACTIVE',frequency:'weekly',weekdays:[1]};
  const at=text=>Date.parse(text+'+08:00');
  assert.equal(nextRun(job,at('2026-10-25T22:00:00')),at('2026-10-26T09:30:00'));
  assert.equal(nextRun(job,at('2026-10-26T09:29:59')),at('2026-10-26T09:30:00'));
  assert.equal(nextRun(job,at('2026-10-26T09:30:00')),at('2026-11-02T09:30:00'));
  assert.equal(nextRun({...job,weekdays:[7]},at('2026-12-31T23:00:00')),at('2027-01-03T09:30:00'));
  assert.equal(nextRun({...job,weekdays:[1,3,5]},at('2026-10-26T10:00:00')),at('2026-10-28T09:30:00'));
  assert.equal(runsOnDay({...job,weekdays:[7]},'2026-10-25'),true);
  assert.equal(runsOnDay({...job,weekdays:[7]},'2026-10-26'),false);
});

test('weekly save validates days and preserves frequency on partial edits and re-enabling',async t=>{
  const f=await fixture(t),input={...f.job,threadRef:f.thread.id,frequency:'weekly',weekdays:[5,1,5],time:'20:00'};
  const saved=await f.store.save(input);assert.deepEqual(saved.weekdays,[1,5]);
  const edited=await f.store.save({id:saved.id,name:'改名',threadRef:f.thread.id,prompt:saved.prompt,time:'21:00',status:'PAUSED'});
  assert.equal(edited.frequency,'weekly');assert.deepEqual(edited.weekdays,[1,5]);
  const resumed=await f.store.save({...f.store.readJob(saved.id),threadRef:f.thread.id,status:'ACTIVE'});
  assert.equal(resumed.frequency,'weekly');assert.deepEqual(resumed.weekdays,[1,5]);
  for(const weekdays of [[],[0],[8],[1.5],['1'],null])await assert.rejects(f.store.save({...input,id:randomUUID(),weekdays}),/星期/);
  await assert.rejects(f.store.save({...input,frequency:'hourly'}),/频率/);
});

test('legacy schedules without recurrence keep daily behavior without migrating their data',async t=>{
  const f=await fixture(t),legacy={...f.job};delete legacy.frequency;delete legacy.weekdays;
  fs.writeFileSync(f.store.jobFile(legacy.id),JSON.stringify(legacy));
  assert.equal(nextRun(legacy,due+1000),due+86400000);
  assert.equal(runsOnDay(legacy,'2026-10-25'),true);
  const edited=await f.store.save({id:legacy.id,name:legacy.name,threadRef:f.thread.id,prompt:legacy.prompt,time:legacy.time});
  assert.equal(edited.frequency,'daily');assert.deepEqual(edited.weekdays,[1,2,3,4,5,6,7]);
});

test('weekly worker dispatches once on selected days and never dispatches on other weekdays',async t=>{
  const f=await fixture(t);f.job=await f.store.save({...f.job,threadRef:f.thread.id,frequency:'weekly',weekdays:[2]});
  let sends=0;const dispatch=async(job,run,mark)=>{mark();sends++;return {turnId:randomUUID()};};
  await tickSchedules(f.store,{now:due-86400000,dispatch});assert.equal(sends,0);
  await tickSchedules(f.store,{now:due,dispatch});await tickSchedules(f.store,{now:due+1000,dispatch});assert.equal(sends,1);
  const run=f.store.run(f.job.id,'2026-10-20');f.store.saveRun({...run,status:'completed_verified'});
  await tickSchedules(f.store,{now:due+86400000,dispatch});assert.equal(sends,1);assert.equal(f.store.run(f.job.id,'2026-10-21'),null);
  const restarted=new ScheduleStore({directory:f.store.directory,now:()=>due+7*86400000});
  await tickSchedules(restarted,{now:due+7*86400000,dispatch});assert.equal(sends,2);
});

test('missed weekly run is recorded for the actual scheduled day with no catch-up or daily phantom runs',async t=>{
  const f=await fixture(t);f.job=await f.store.save({...f.job,threadRef:f.thread.id,frequency:'weekly',weekdays:[2]});
  const wake=due+3*86400000;f.setNow(wake);
  await tickSchedules(f.store,{now:wake,dispatch:async()=>assert.fail('must not catch up')});
  assert.equal(f.store.run(f.job.id,'2026-10-20').status,'missed');
  for(const day of ['2026-10-21','2026-10-22','2026-10-23'])assert.equal(f.store.run(f.job.id,day),null);
});

test('duplicate protection compares overlapping weekdays and allows distinct weekly dates',async t=>{
  const f=await fixture(t);f.job=await f.store.save({...f.job,threadRef:f.thread.id,frequency:'weekly',weekdays:[1]});
  const other={...f.job,id:randomUUID(),threadRef:f.thread.id,weekdays:[2]};await f.store.save(other);
  await assert.rejects(f.store.save({...other,id:randomUUID(),weekdays:[1,3]}),/重叠/);
  await assert.rejects(f.store.save({...other,id:randomUUID(),frequency:'daily'}),/重叠/);
});

test('each task retains its chosen provider, model and effort through edits and dispatch',async t=>{
  const f=await fixture(t);
  f.store.read=()=>({model_providers:{other:{base_url:'https://other.example/v1',wire_api:'responses'}}});
  f.thread.modelProvider='other';
  const input={id:randomUUID(),name:'其他供应商任务',threadRef:f.thread.id,prompt:'执行任务',time:'22:00',status:'PAUSED',providerId:'other',model:'other-model',effort:'high'};
  const saved=await f.store.save(input);
  assert.equal(saved.providerId,'other');assert.equal(saved.model,'other-model');assert.equal(saved.effort,'high');
  await f.store.save({...input,name:'编辑后的任务',time:'21:00'});
  const restored=f.store.readJob(input.id),request=scheduledTurnRequest(restored,{day:'2026-10-20',clientUserMessageId:randomUUID()});
  assert.equal(restored.providerId,'other');assert.equal(request.model,'other-model');assert.equal(request.effort,'high');
  assert.equal(request.collaborationMode.settings.model,'other-model');assert.equal(request.collaborationMode.settings.reasoning_effort,'high');
  await assert.rejects(f.store.save({...input,providerId:'custom'}),/供应商/);
});

test('account provider schedules store the selected account model instead of Qwen defaults',async t=>{
  const f=await fixture(t);f.thread.modelProvider='openai';
  const saved=await f.store.save({id:randomUUID(),name:'账号模型任务',threadRef:f.thread.id,prompt:'执行任务',time:'21:00',status:'PAUSED',providerId:'openai',model:'gpt-6.1-sol',effort:'medium'});
  assert.equal(saved.providerId,'openai');assert.equal(saved.model,'gpt-6.1-sol');assert.equal(saved.effort,'medium');
});
test('schedule sends one explicit Qwen collaboration mode per daily slot, including after restart',async t=>{
  const f=await fixture(t);f.setNow(due);let sends=0;
  const dispatch=async(job,run,mark)=>{assert.equal(job.providerId,'custom');const request=scheduledTurnRequest(job,run);assert.equal(request.model,'qwen3.8-27b');assert.equal(request.effort,'xhigh');assert.equal(request.collaborationMode.settings.model,'qwen3.8-27b');assert.equal(request.collaborationMode.settings.reasoning_effort,'xhigh');mark();assert.equal(f.store.run(job.id,run.day).status,'submitting');sends++;return{turnId:randomUUID()};};
  await tickSchedules(f.store,{now:due,dispatch});await tickSchedules(f.store,{now:due+1000,dispatch});
  const restarted=new ScheduleStore({directory:f.store.directory,now:()=>due+2000});
  await tickSchedules(restarted,{now:due+2000,dispatch});assert.equal(sends,1);
});
test('unknown outcome after submit is persisted and never automatically retried on later days',async t=>{
  const f=await fixture(t);f.setNow(due);let sends=0;
  const dispatch=async(job,run,mark)=>{mark();sends++;throw new Error('timeout after write');};
  await tickSchedules(f.store,{now:due,dispatch});
  assert.equal(f.store.run(f.job.id,'2026-10-20').status,'unknown');
  await tickSchedules(f.store,{now:due+1000,dispatch});await tickSchedules(f.store,{now:due+86400000*20,dispatch});
  assert.equal(sends,1);
});
test('desktop unavailable and busy preflight waits without submission and expires without catch-up',async t=>{
  const f=await fixture(t);f.setNow(due);let attempts=0;
  const dispatch=async()=>{attempts++;throw new Error('desktop offline');};
  await tickSchedules(f.store,{now:due,dispatch});await tickSchedules(f.store,{now:due+1000,dispatch});
  assert.equal(f.store.run(f.job.id,'2026-10-20').status,'waiting');
  await tickSchedules(f.store,{now:due+GRACE_MS+1,dispatch});assert.equal(attempts,2);
  assert.equal(f.store.run(f.job.id,'2026-10-20').status,'missed');
});
test('task paused or edited during preflight cannot submit',async t=>{
  const f=await fixture(t);f.setNow(due);let sent=false;
  await tickSchedules(f.store,{now:due,dispatch:async(job,run,mark)=>{f.store.setStatus(job.id,'PAUSED');mark();sent=true;}});
  assert.equal(sent,false);assert.equal(f.store.run(f.job.id,'2026-10-20').status,'waiting');
});
test('new schedule created after its time is not immediately backfilled',async t=>{
  const f=await fixture(t);f.setNow(due+1000);
  const job=await f.store.save({id:randomUUID(),name:'新任务',threadRef:f.thread.id,prompt:'任务',time:'23:00',status:'ACTIVE'});
  f.store.setStatus(f.job.id,'PAUSED');let sends=0;
  await tickSchedules(f.store,{now:due+2000,dispatch:async()=>{sends++;}});
  assert.equal(sends,0);assert.equal(f.store.run(job.id,'2026-10-20'),null);
});
test('scheduled preflight refuses mismatched provider, active turn, and stale GPT context',async t=>{
  const f=await fixture(t);
  await scheduledPreflight(f.job,{rpc:f.rpc});
  f.thread.modelProvider='openai';await assert.rejects(scheduledPreflight(f.job,{rpc:f.rpc}),/供应商/);
  f.thread.modelProvider='custom';f.thread.status={type:'active'};await assert.rejects(scheduledPreflight(f.job,{rpc:f.rpc}),/正在运行/);
  f.thread.status={type:'notLoaded'};fs.writeFileSync(f.rollout,JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol'}})+'\n');
  await assert.rejects(scheduledPreflight(f.job,{rpc:f.rpc}),/\/compact/);
});
test('desktop dispatch fixes both model and collaboration mode and marks before native write',async t=>{
  const f=await fixture(t);let marked=false,request;
  class Reader{
    async connect(){} async settings(){return {resumeState:'resumed',modelProvider:'custom'};}
    async setModel(id,provider,model,effort){assert.equal(provider,'custom');assert.equal(model,'qwen3.8-27b');assert.equal(effort,'xhigh');}
    async request(method,params){if(method==='thread-owner-discovery')return{resultType:'success',handledByClientId:'owner'};assert.equal(method,'thread-follower-start-turn');assert.equal(marked,true);request=params.turnStart.request;return{resultType:'success',result:{result:{turn:{id:f.turnId}}}};}
    close(){}
  }
  const result=await dispatchScheduled(f.job,{day:'2026-10-20',clientUserMessageId:randomUUID()},()=>{marked=true;},{rpc:f.rpc,Reader,read:()=>config});
  assert.equal(result.turnId,f.turnId);assert.equal(request.collaborationMode.settings.model,'qwen3.8-27b');assert.match(request.input[0].text,/生成今日日报/);
});
test('completion is distinct from acceptance and the recorded model is verified',async t=>{
  const f=await fixture(t);
  const done=await observeScheduled(f.job,{turnId:f.turnId},{rpc:f.rpc});assert.equal(done.status,'completed_verified');assert.equal(done.observedModel,'qwen3.8-27b');
  fs.writeFileSync(f.rollout,JSON.stringify({type:'turn_context',payload:{turn_id:f.turnId,model:'gpt-6.1-sol'}})+'\n');
  assert.equal((await observeScheduled(f.job,{turnId:f.turnId},{rpc:f.rpc})).status,'model_mismatch');
});
test('a model mismatch pauses future scheduled runs',async t=>{
  const f=await fixture(t);const run=f.store.claim(f.job,'2026-10-19');f.store.saveRun({...run,status:'accepted',turnId:f.turnId});
  await tickSchedules(f.store,{now:due-1,observe:async()=>({status:'model_mismatch'}),dispatch:async()=>assert.fail('must not send')});
  assert.equal(f.store.readJob(f.job.id).status,'PAUSED');
});
test('manual acknowledgement unlocks future days without replaying the uncertain slot',async t=>{
  const f=await fixture(t);f.setNow(due);const run=f.store.claim(f.job,'2026-10-20');f.store.saveRun({...run,status:'unknown'});
  assert.throws(()=>f.store.acknowledge(f.job.id,run.day));f.setNow(due+180000);
  f.store.acknowledge(f.job.id,run.day);let sends=0;
  await tickSchedules(f.store,{now:due+180000,dispatch:async()=>{sends++;}});assert.equal(sends,0);
  f.setNow(due+86400000);await tickSchedules(f.store,{now:due+86400000,dispatch:async(job,run,mark)=>{mark();sends++;return{turnId:randomUUID()};}});assert.equal(sends,1);
});

test('duplicate active schedules cannot be created for the same time and prompt',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.store.save({id:randomUUID(),name:'重复',threadRef:f.thread.id,prompt:'生成今日日报',time:'23:00',status:'ACTIVE'}),/已有相同/);
});

test('waking on the next day records the missed slot without sending it',async t=>{
  const f=await fixture(t);const wake=due+10*3600000;f.setNow(wake);let sends=0;
  await tickSchedules(f.store,{now:wake,dispatch:async()=>{sends++;}});
  assert.equal(sends,0);assert.equal(f.store.run(f.job.id,'2026-10-20').status,'missed');
});
