import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {persistProviderSwitch} from '../src/provider-switch.mjs';
import {LauncherService} from '../src/service.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ProviderChangeStore,processProviderChanges} from '../src/provider-changes.mjs';

const config={model_providers:{custom:{base_url:'https://gateway.example/v1',wire_api:'responses'}}};
function fixture(){
  const thread={id:randomUUID(),modelProvider:'openai',cwd:'C:/project',projectId:randomUUID(),name:'原会话',status:{type:'notLoaded'}};
  const initial={...thread},calls=[];let process=0,effort='medium',model='gpt-example',busy=false,badReadback=false;
  const rpc=async action=>{const connection=++process;return action({request:async(method,args)=>{
    calls.push({connection,method,args});
    if(method==='thread/read')return {thread:{...thread}};
    if(method==='thread/turns/list')return {data:[{status:busy?'inProgress':'completed'}]};
    if(method==='thread/resume'){
      if(args.modelProvider){thread.modelProvider=args.modelProvider;model=args.model;effort=args.config.model_reasoning_effort;}
      return {thread:{...thread},modelProvider:thread.modelProvider,model:badReadback&&!args.modelProvider?'wrong':model,reasoningEffort:effort};
    }
    if(method==='thread/settings/update'){effort=args.effort;return {};}
    assert.fail('unexpected mutation '+method);
  }});};
  return {thread,initial,calls,rpc,setBusy:v=>{busy=v;},badReadback:()=>{badReadback=true;}};
}
test('provider switch uses separate official resume connections and verifies persisted routing without changing thread identity',async()=>{
  const f=fixture();const result=await persistProviderSwitch(f.thread,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh',{rpc:f.rpc});
  assert.equal(result.id,f.initial.id);assert.equal(result.cwd,f.initial.cwd);assert.equal(result.projectId,f.initial.projectId);assert.equal(result.name,f.initial.name);assert.equal(result.modelProvider,'custom');
  const resumes=f.calls.filter(c=>c.method==='thread/resume');assert.equal(resumes.length,2);assert.notEqual(resumes[0].connection,resumes[1].connection);
  assert.deepEqual(resumes[1].args,{threadId:f.initial.id,excludeTurns:true});
  const update=f.calls.find(c=>c.method==='thread/settings/update');assert.equal(update.args.collaborationMode.settings.model,'qwen3.8-27b');
  assert.ok(!f.calls.some(c=>/turn\/start|thread\/start|thread\/fork|config\/|compact|inject|name\/set/.test(c.method)));
});
test('switching a busy thread or a concurrently changed provider cannot mutate it',async()=>{
  const f=fixture();f.setBusy(true);
  await assert.rejects(persistProviderSwitch(f.thread,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh',{rpc:f.rpc}),/正在运行/);
  assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
  f.setBusy(false);const old={...f.thread};f.thread.modelProvider='another';
  await assert.rejects(persistProviderSwitch(old,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh',{rpc:f.rpc}),/其他操作/);
});
test('a failed fresh readback cannot report a confirmed provider switch',async()=>{
  const f=fixture();f.badReadback();
  await assert.rejects(persistProviderSwitch(f.thread,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh',{rpc:f.rpc}),/重新加载后/);
});
test('an authorized change queues the original thread without claiming its loaded provider changed',async t=>{
  const f=fixture();let confirms=0;
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-change-test-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  const service=new LauncherService({stateDir,read:()=>config,rpc:f.rpc,confirm:async()=>{confirms++;}});
  let changeId;
  for(let i=0;i<2;i++){
    const result=await service.modifyExisting({threadRef:f.thread.id,switchProvider:true});
    assert.equal(result.status,'provider_change_queued');assert.equal(result.providerSaved,false);assert.equal(result.requiresDesktopReload,true);
    assert.equal(result.threadId,f.initial.id);assert.match(result.note,/当前尚未修改/);
    if(changeId)assert.equal(result.change.id,changeId);changeId=result.change.id;
  }
  assert.equal(confirms,0);assert.equal(f.thread.modelProvider,'openai');assert.ok(!f.calls.some(c=>c.method==='thread/resume'));
});
function queueFixture(t){const f=fixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'provider-queue-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const store=new ProviderChangeStore({directory});store.enqueue(f.thread,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh');return {...f,store};}
test('background waits for the desktop writer to leave, then verifies the saved provider',async t=>{
  const f=queueFixture(t),options={rpc:f.rpc,read:()=>config};
  await processProviderChanges(f.store,{...options,open:async()=>{},isLoaded:async()=>true});assert.equal(f.calls.length,0);assert.equal(f.store.get(f.thread.id).status,'waiting');
  await processProviderChanges(f.store,{...options,open:async()=>{},isLoaded:async()=>false});assert.equal(f.store.get(f.thread.id).status,'saved');assert.equal(f.thread.modelProvider,'custom');
  const count=f.calls.length;await processProviderChanges(f.store,{...options,open:async()=>{},isLoaded:async()=>false});assert.equal(f.calls.length,count);
});
test('an active writer lock remains queued without consuming retry attempts',async t=>{
  const f=queueFixture(t);await processProviderChanges(f.store,{rpc:f.rpc,read:()=>config,open:async()=>{},isLoaded:async()=>false,persist:async()=>{const e=new Error('locked');e.code='THREAD_WRITER_ACTIVE';throw e;}});
  const job=f.store.get(f.thread.id);assert.equal(job.status,'waiting');assert.equal(job.attempts,0);assert.equal(f.thread.modelProvider,'openai');
});
test('cancelled or externally changed queued threads cannot be switched',async t=>{
  const f=queueFixture(t);await processProviderChanges(f.store,{rpc:f.rpc,read:()=>config,open:async()=>{},isLoaded:async()=>{f.store.cancel(f.thread.id);return false;},persist:async()=>assert.fail('cancelled')});assert.equal(f.store.get(f.thread.id).status,'cancelled');
  f.store.enqueue(f.thread,{modelProvider:'custom',model:'qwen3.8-27b'},'xhigh');f.thread.modelProvider='another';
  for(let i=0;i<5;i++)await processProviderChanges(f.store,{rpc:f.rpc,read:()=>config,open:async()=>{},isLoaded:async()=>false,persist:async()=>assert.fail('provider changed')});
  assert.equal(f.store.get(f.thread.id).status,'failed');
});
test('a worker restart resumes an unfinished provider change without creating a new thread',async t=>{
  const f=queueFixture(t),job=f.store.get(f.thread.id);f.store.write({...job,status:'applying'});
  await processProviderChanges(new ProviderChangeStore({directory:f.store.directory}),{rpc:f.rpc,read:()=>config,open:async()=>{},isLoaded:async()=>false});
  assert.equal(f.store.get(f.thread.id).status,'saved');assert.equal(f.thread.id,f.initial.id);
});
test('a superseded or cancelled change cannot be claimed, and reopening happens only after saved readback',async t=>{
  const f=queueFixture(t),first=f.store.get(f.thread.id);
  f.store.cancel(f.thread.id);assert.equal(f.store.transition(f.thread.id,first.id,['waiting'],{status:'applying'}),null);
  const next=f.store.enqueue(f.thread,{modelProvider:'custom',model:'different-model'},'high');
  assert.notEqual(next.id,first.id);assert.equal(f.store.transition(f.thread.id,first.id,['waiting'],{status:'applying'}),null);
  let opened=0;
  await processProviderChanges(f.store,{rpc:f.rpc,read:()=>config,isLoaded:async()=>false,open:async id=>{assert.equal(id,f.thread.id);assert.equal(f.store.get(id).status,'saved');opened++;}});
  assert.equal(opened,1);
});
