import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {providerList,discoverModels,requireSelection,launcherDefaults} from '../src/providers.mjs';
import {LauncherService,confirmDesktop,existingThreadId} from '../src/service.mjs';
import {DesktopReader} from '../src/desktop-ipc.mjs';
import {buildCatalog} from '../src/catalog.mjs';
import {NativeSettings} from '../src/settings.mjs';
import {listProjects} from '../src/projects.mjs';

const config={model:'gpt-example',model_providers:{custom:{name:'网关',base_url:'https://user:password@gateway.example/v1?key=private-key',experimental_bearer_token:'private-key',wire_api:'responses',model:'misplaced'}}};
test('public provider metadata strips every credential location',()=>{
  const data=providerList(config),text=JSON.stringify(data);
  for(const secret of ['private-key','password','user:'])assert.ok(!text.includes(secret));
  assert.equal(data.defaultProvider,'openai');assert.equal(data.providers[1].baseUrl,'https://gateway.example/v1');
  assert.ok(data.providers[1].configurationNote);
});
test('provider selection is explicit and never inferred from a model slug',()=>{
  assert.deepEqual(requireSelection(config,'custom','qwen-demo'),{modelProvider:'custom',model:'qwen-demo'});
  assert.throws(()=>requireSelection(config,'qwen','qwen-demo'));
});
test('launcher defaults prefer custom Qwen xhigh without changing global defaults',()=>{
  const before=structuredClone(config);
  assert.deepEqual(launcherDefaults(config),{providerId:'custom',model:'qwen3.8-27b',effort:'xhigh'});
  assert.deepEqual(config,before);
  assert.deepEqual(launcherDefaults({model:'gpt-example',model_reasoning_effort:'high'}),{providerId:'openai',model:'gpt-example',effort:'high'});
});
test('model discovery uses only the chosen provider and disallows credential redirects',async()=>{
  const safe={model_providers:{custom:{base_url:'https://gateway.example/v1',env_key:'LOCAL_KEY'}}};
  let request;
  const result=await discoverModels(safe,'custom',{env:{LOCAL_KEY:'secret'},fetchImpl:async(url,opts)=>{
    request={url:String(url),opts};return new Response(JSON.stringify({data:[{id:'qwen-demo'},{id:'qwen-demo'}]}));
  }});
  assert.equal(request.url,'https://gateway.example/v1/models');assert.equal(request.opts.redirect,'error');
  assert.equal(request.opts.headers.Authorization,'Bearer secret');assert.equal(result.models.length,1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('concurrent and post-restart retries create exactly one real thread',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  let starts=0;const threadId=randomUUID(),projectId=randomUUID();
  const rpc=async action=>action({request:async(method,params)=>{
    if(method==='project/read')return{project:{id:projectId,name:'已有项目',roots:[{path:stateDir}]}};
    if(method==='thread/start'){starts++;assert.equal(params.projectId,projectId);assert.equal(params.config.model_reasoning_effort,'xhigh');await new Promise(r=>setTimeout(r,20));return{thread:{id:threadId}};}
    if(method==='thread/read')return{thread:{projectId,cwd:stateDir}};
    return{};
  }});
  const confirm=async record=>({...record,status:'settings_verified',observed:{model:record.model,modelProvider:record.providerId,reasoningEffort:record.effort}});
  const options={read:()=>config,rpc,confirm,stateDir};
  const service=new LauncherService(options),args={operationId:randomUUID(),providerId:'custom',model:'qwen-demo',projectId,cwd:stateDir,title:'测试',effort:'xhigh'};
  const [a,b]=await Promise.all([service.create(args),service.create(args)]);
  assert.equal(starts,1);assert.equal(a.threadId,b.threadId);
  assert.equal(a.projectVerified,true);assert.equal(a.projectId,projectId);assert.equal(a.observed.reasoningEffort,'xhigh');
  assert.equal((await new LauncherService(options).create(args)).threadId,threadId);assert.equal(starts,1);
  await assert.rejects(new LauncherService(options).create({...args,model:'other'}));
});
test('unknown start result is never automatically replayed',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  let calls=0;const projectId=randomUUID(),options={stateDir,read:()=>config,rpc:async action=>action({request:async method=>{
    if(method==='project/read')return{project:{id:projectId,roots:[{path:stateDir}]}};
    if(method==='thread/start'){calls++;throw new Error('timeout');}
  }})};
  const args={operationId:randomUUID(),providerId:'custom',model:'qwen-demo',projectId,cwd:stateDir,title:'测试'};
  await assert.rejects(new LauncherService(options).create(args));
  await assert.rejects(new LauncherService(options).create(args),/未自动重试/);assert.equal(calls,1);
});
test('desktop confirmation failure returns the existing ID for recovery',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  const threadId=randomUUID(),projectId=randomUUID(),service=new LauncherService({stateDir,read:()=>config,
    rpc:async action=>action({request:async method=>method==='project/read'?{project:{id:projectId,roots:[{path:stateDir}]}}:method==='thread/start'?{thread:{id:threadId}}:method==='thread/read'?{thread:{projectId,cwd:stateDir}}:{}}),
    confirm:async()=>{throw new Error('桌面正在加载');}});
  const result=await service.create({operationId:randomUUID(),providerId:'custom',model:'qwen-demo',projectId,cwd:stateDir,title:'测试'});
  assert.equal(result.threadId,threadId);assert.equal(result.status,'needs_confirmation');
});
test('a custom catalog preserves official metadata and exposes explicit supplier effort overrides',()=>{
  const original={slug:'gpt-example',supported_reasoning_levels:[{effort:'xhigh'}],tool_mode:'code_mode_only'};
  const result=buildCatalog({source:{models:[original]},models:['qwen-demo']});
  assert.deepEqual(result.models[0],original);assert.equal(result.models[1].default_reasoning_level,'xhigh');
  assert.ok(result.models[1].supported_reasoning_levels.some(e=>e.effort==='xhigh'));assert.equal(result.models[1].supports_reasoning_effort_updates,true);
});
test('native settings use saved projects and persist xhigh for custom suppliers',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const projectId=randomUUID();let launch;
  const service={models:async()=>({models:[{id:'qwen3.8-27b'}]}),projects:async()=>[{id:projectId,name:'项目名称',roots:[directory]}],create:async args=>{launch=args;return args;}};
  const settings=new NativeSettings(service,{directory,read:()=>config});
  const initial=await settings.get();assert.equal(initial.values.providerId,'custom');assert.equal(initial.values.model,'qwen3.8-27b');assert.equal(initial.values.effort,'xhigh');assert.ok(!fs.existsSync(settings.file()));
  assert.deepEqual(initial.schema.properties.project.enum,[`项目名称 · ${directory}`]);assert.ok(!initial.schema.properties.cwd);
  await settings.update({project:initial.values.project,effort:'xhigh'});
  await settings.update({providerId:'openai'});
  const updated=await settings.update({providerId:'custom'});
  assert.equal(updated.values.model,'qwen3.8-27b');assert.equal(updated.values.effort,'xhigh');
  await settings.update({effort:'high'});await settings.update({effort:'xhigh'});
  assert.ok((await settings.get()).layout.some(group=>group.items.some(i=>i.tool==='launch_from_settings')));
  await new NativeSettings(service,{directory,read:()=>config}).launch();
  assert.equal(launch.projectId,projectId);assert.equal(launch.cwd,directory);assert.equal(launch.effort,'xhigh');
  await assert.rejects(settings.update({project:'不存在的项目'}));
  await assert.rejects(settings.update({apiKey:'secret'}));
});
test('project list follows pagination and uses app-server project identities',async()=>{
  const first=randomUUID(),second=randomUUID();let calls=0;
  const projects=await listProjects({request:async(method,args)=>{
    assert.equal(method,'project/list');calls++;
    return args.cursor?{data:[{id:second,name:'二',roots:[{path:os.tmpdir()}]}],nextCursor:null}:{data:[{id:first,name:'一',roots:[{path:os.tmpdir()}]}],nextCursor:'next'};
  }});
  assert.equal(calls,2);assert.deepEqual(projects.map(p=>p.id),[first,second]);
});
test('creation rejects a directory outside the selected project before creating a thread',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let starts=0;const service=new LauncherService({stateDir:directory,read:()=>config,rpc:async action=>action({request:async method=>{
    if(method==='project/read')return{project:{roots:[{path:directory}]}};
    starts++;return{};
  }})});
  await assert.rejects(service.create({operationId:randomUUID(),providerId:'custom',model:'qwen-demo',projectId:randomUUID(),cwd:os.tmpdir(),title:'测试'}),/来自所选/);
  assert.equal(starts,0);
});
test('a deleted selected project never silently falls back to another project',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const original=randomUUID();let projects=[{id:original,name:'原项目',roots:[directory]}],starts=0;
  const settings=new NativeSettings({projects:async()=>projects,create:async()=>{starts++;}},{directory,read:()=>config});
  await settings.update({project:`原项目 · ${directory}`,effort:'xhigh'});
  projects=[{id:randomUUID(),name:'其他项目',roots:[directory]}];
  await assert.rejects(settings.launch(),/已不存在/);assert.equal(starts,0);
});
test('project readback mismatch keeps the created ID and cannot report verified',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const threadId=randomUUID();let confirmations=0;
  const service=new LauncherService({stateDir:directory,read:()=>config,confirm:async()=>{confirmations++;},rpc:async action=>action({request:async method=>
    method==='project/read'?{project:{roots:[{path:directory}]}}:method==='thread/start'?{thread:{id:threadId}}:method==='thread/read'?{thread:{projectId:randomUUID(),cwd:directory}}:{}})});
  const result=await service.create({operationId:randomUUID(),providerId:'custom',model:'qwen-demo',projectId:randomUUID(),cwd:directory,title:'测试'});
  assert.equal(result.threadId,threadId);assert.notEqual(result.status,'settings_verified');assert.equal(confirmations,0);
  assert.equal((await service.complete(result.operationId)).status,'needs_confirmation');assert.equal(confirmations,0);
});

test('empty desktop provider is initialized only after the stored provider is verified',async()=>{
  const reader=new DesktopReader(),threadId=randomUUID();let time=0,updates=0,reads=0;
  const pending={model:'gpt-example',modelProvider:'',reasoningEffort:null,resumeState:'resumed'};
  const applied={...pending,model:'qwen-demo',reasoningEffort:'xhigh'};
  const final={...applied,modelProvider:'custom'};
  reader.settings=async()=>[pending,applied,applied,final][Math.min(reads++,3)];
  reader.request=async(method,params)=>{
    if(method==='thread-owner-discovery')return{resultType:'success',handledByClientId:'owner'};
    updates++;assert.equal(params.condition.ifModelEquals,'gpt-example');return{resultType:'success',result:{applied:true}};
  };
  await assert.rejects(reader.setModel(threadId,'custom','qwen-demo','xhigh'),/供应商与选择不一致/);assert.equal(updates,0);
  reads=0;
  const result=await reader.setModel(threadId,'custom','qwen-demo','xhigh',{verifiedStoredProvider:'custom',settleMs:20,pollMs:1,now:()=>time,sleep:async ms=>{time+=ms;}});
  assert.equal(result.modelProvider,'custom');assert.equal(result.model,'qwen-demo');assert.equal(updates,1);assert.ok(reads>=4);
});
test('a concrete different desktop provider cannot be overwritten by a stored-provider hint',async()=>{
  const reader=new DesktopReader();let requests=0;
  reader.settings=async()=>({model:'gpt-example',modelProvider:'openai',reasoningEffort:null,resumeState:'resumed'});
  reader.request=async()=>{requests++;};
  await assert.rejects(reader.setModel(randomUUID(),'custom','qwen-demo','xhigh',{verifiedStoredProvider:'custom'}),/供应商与选择不一致/);
  assert.equal(requests,0);
});
test('missing provider notification times out instead of reporting an optimistic model update as verified',async()=>{
  const reader=new DesktopReader();let time=0;
  reader.settings=async()=>({model:'qwen-demo',modelProvider:'',reasoningEffort:'xhigh',resumeState:'resumed'});
  reader.request=async method=>method==='thread-owner-discovery'?{resultType:'success',handledByClientId:'owner'}:{resultType:'success',result:{applied:true}};
  await assert.rejects(reader.setModel(randomUUID(),'custom','qwen-demo','xhigh',{verifiedStoredProvider:'custom',settleMs:3,pollMs:1,now:()=>time,sleep:async ms=>{time+=ms;}}),/通知尚未完成/);
});
test('confirmation waits for resume and verifies the persisted identity before model updates',async()=>{
  const thread={threadId:randomUUID(),providerId:'custom',model:'qwen-demo',effort:'xhigh'};let time=0,reads=0,opens=0,closed=0,verified;
  class Reader {
    async connect(){}
    async settings(){reads++;return reads===1?{resumeState:'resuming',modelProvider:''}:{resumeState:'resumed',modelProvider:''};}
    async setModel(id,provider,model,effort,options){verified=options.verifiedStoredProvider;return{modelProvider:provider,model,reasoningEffort:effort};}
    close(){closed++;}
  }
  const options={Reader,open:async()=>{opens++;},readThread:async id=>({id,modelProvider:'custom'}),timeoutMs:10,pollMs:1,now:()=>time,sleep:async ms=>{time+=ms;}};
  assert.equal((await confirmDesktop(thread,options)).status,'settings_verified');assert.equal(reads,2);assert.equal(verified,'custom');assert.equal(closed,1);
  await assert.rejects(confirmDesktop(thread,{...options,readThread:async id=>({id,modelProvider:'openai'})}),/保存的供应商/);
  assert.equal(opens,1);
});

test('existing thread references accept only a local thread ID or exact Codex thread link',()=>{
  const id=randomUUID();
  assert.equal(existingThreadId(id),id);assert.equal(existingThreadId(` codex://threads/${id} `),id);
  for(const ref of ['',`https://example.com/${id}`,`codex://threads/${id}?other=1`,null])assert.throws(()=>existingThreadId(ref));
});

test('modifying an existing thread defaults to Qwen xhigh and never creates or renames a thread',async()=>{
  const id=randomUUID(),calls=[];let confirmed;
  const thread={id,name:'日报',modelProvider:'custom',cwd:os.tmpdir(),projectId:randomUUID()};
  const service=new LauncherService({read:()=>config,rpc:async action=>action({request:async(method,args)=>{
    calls.push(method);assert.equal(method,'thread/read');assert.equal(args.threadId,id);return {thread};
  }}),confirm:async(record,{readThread})=>{
    confirmed=record;assert.deepEqual(await readThread(record.threadId),thread);
    return {...record,status:'settings_verified',observed:{model:record.model,modelProvider:record.providerId,reasoningEffort:record.effort}};
  }});
  const result=await service.modifyExisting({threadRef:`codex://threads/${id}`});
  assert.equal(result.threadId,id);assert.equal(result.model,'qwen3.8-27b');assert.equal(result.effort,'xhigh');
  assert.equal(result.title,'日报');assert.equal(result.cwd,thread.cwd);assert.equal(confirmed.providerId,'custom');
  assert.equal(result.status,'settings_verified');assert.deepEqual(calls,['thread/read','thread/read']);
});

test('existing thread provider mismatch and invalid input cannot reach desktop mutation',async()=>{
  const id=randomUUID();let confirms=0,reads=0;
  const service=new LauncherService({read:()=>config,rpc:async action=>action({request:async()=>{reads++;return {thread:{id,modelProvider:'openai'}};}}),confirm:async()=>{confirms++;}});
  await assert.rejects(service.modifyExisting({threadRef:id}),/供应商是 openai/);
  await assert.rejects(service.modifyExisting({threadRef:'not-a-thread'}));
  await assert.rejects(service.modifyExisting({threadRef:id,model:'\ninvalid'}));
  await assert.rejects(service.modifyExisting({threadRef:id,effort:'unknown'}));
  assert.equal(reads,1);assert.equal(confirms,0);
});

test('existing thread failed readback stays unconfirmed and retries target the same ID',async()=>{
  const id=randomUUID();let confirmations=0;
  const service=new LauncherService({read:()=>config,rpc:async action=>action({request:async(method)=>{
    assert.equal(method,'thread/read');return {thread:{id,modelProvider:'custom'}};
  }}),confirm:async record=>{confirmations++;assert.equal(record.threadId,id);throw new Error('desktop timeout');}});
  for(let i=0;i<2;i++){
    const result=await service.modifyExisting({threadRef:id});
    assert.equal(result.status,'needs_confirmation');assert.equal(result.threadId,id);assert.match(result.note,/尚未确认/);
  }
  assert.equal(confirmations,2);
});

test('existing thread picker preserves pagination and filters out other providers',async()=>{
  const id=randomUUID(),other=randomUUID();let requested;
  const service=new LauncherService({read:()=>config,rpc:async action=>action({request:async(method,args)=>{
    assert.equal(method,'thread/list');requested=args;return {data:[{id,name:'已有日报',modelProvider:'custom'},{id:other,modelProvider:'openai'}],nextCursor:'page-2'};
  }})});
  const page=await service.existingThreads({cursor:'page-1'});
  assert.deepEqual(requested.modelProviders,['custom']);assert.equal(requested.cursor,'page-1');
  assert.deepEqual(page.threads.map(t=>t.id),[id]);assert.equal(page.nextCursor,'page-2');
});

test('native existing-thread settings work without any project and preserve creation settings',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-launcher-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const id=randomUUID();let modified;
  const settings=new NativeSettings({projects:async()=>[],modifyExisting:async args=>{modified=args;return args;}},{directory,read:()=>config});
  const initial=await settings.get();
  assert.equal(initial.values.editModel,'qwen3.8-27b');assert.equal(initial.values.editEffort,'xhigh');
  assert.ok(initial.layout.some(g=>g.items.some(i=>i.tool==='modify_from_settings')));
  await settings.update({editThread:`codex://threads/${id}`});
  await new NativeSettings(settings.service,{directory,read:()=>config}).modify();
  assert.equal(modified.providerId,'custom');assert.equal(modified.model,'qwen3.8-27b');assert.equal(modified.effort,'xhigh');
  assert.equal(settings.values().title,'新会话');assert.equal(modified.threadRef,`codex://threads/${id}`);
});
