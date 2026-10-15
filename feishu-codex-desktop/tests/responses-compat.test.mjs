import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeDelegations,createResponsesCompatServer} from '../src/responses-compat.mjs';
import {DesktopClient} from '../src/desktop.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-responses-compat-test-'));
process.env.FEISHU_CODEX_DATA_DIR=path.join(folder,'private');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {providerConfig,configureResponsesCompat,prepareNewThreadCompat,syncResponsesCompatRuntime,ensureResponsesCompat}=await import('../src/responses-compat-settings.mjs');
const {readJson,writeJson}=await import('../src/storage.mjs');
const delegated=output=>({type:'function_call_output',id:'fco_fixture',name:'create_thread',namespace:'codex_app',
  output:`<codex_delegation>\n  <source_thread_id>genuine-source</source_thread_id>\n  <input>${output}</input>\n</codex_delegation>`});

test('only native Codex delegation without call_id becomes ordinary user text',()=>{
  const text='保留中文逗号，&lt;任务&gt; &amp; \n第二行';
  const valid={...delegated('real tool result'),call_id:'call_existing'};
  const unknown={...delegated('unknown tool'),name:'shell_exec'};
  const external={...delegated('external data'),namespace:'other'};
  const plain={type:'message',role:'user',content:'do not change'};
  const malformed={...delegated('x'),output:'not a native delegation'};
  const body={model:'configured-model',stream:true,tools:[{type:'function',name:'existing'}],input:[plain,delegated(text),valid,unknown,external,malformed]};
  const result=normalizeDelegations(body);
  assert.equal(result.converted,1);
  assert.deepEqual(result.body.input[1],{type:'message',role:'user',content:[{type:'input_text',text:'保留中文逗号，<任务> & \n第二行'}]});
  assert.equal(result.body.model,body.model);assert.equal(result.body.tools,body.tools);
  assert.deepEqual(result.body.input.filter((_,i)=>i!==1),[plain,valid,unknown,external,malformed]);
  assert.equal(body.input[1].type,'function_call_output');
  assert.equal(normalizeDelegations({input:[valid]}).converted,0);
  assert.deepEqual(normalizeDelegations({input:'plain string'}),{body:{input:'plain string'},converted:0});
  assert.equal(normalizeDelegations({input:[{...delegated('hello'),name:'send_message_to_thread'}]}).converted,1);
});

async function listen(server) {await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function close(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
test('loopback proxy preserves SSE bytes, authentication, model and real tools; handles gzip without retries',async()=>{
  const received=[];const payload=Buffer.from('event: response.output_text.delta\ndata: {"delta":"你好，世界"}\n\nevent: response.completed\ndata: {}\n\n');
  const upstream=http.createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    received.push({headers:req.headers,url:req.url,body:JSON.parse(Buffer.concat(parts).toString())});
    res.writeHead(200,{'Content-Type':'text/event-stream','x-fixture-id':'preserved'});
    res.write(payload.subarray(0,25));setTimeout(()=>res.end(payload.subarray(25)),5);
  });
  const upstreamUrl=await listen(upstream);
  const proxy=createResponsesCompatServer({instanceId:'fixture-instance',allowTestHttp:true,
    getRoutes:()=>[{token:'fixture-route',upstream:upstreamUrl+'/v1/'}],onConverted:()=>{throw new Error('Diagnostic storage unavailable');}});
  const base=await listen(proxy);
  try {
    assert.equal(proxy.address().address,'127.0.0.1');
    const input={model:'original-model',reasoning:{effort:'xhigh'},stream:true,input:[delegated('用户原文，完整保留')]};
    const compressed=gzipSync(JSON.stringify(input));
    const reply=await fetch(base+'/fixture-route/responses?api-version=fixture',{method:'POST',
      headers:{authorization:'Bearer fixture-private-key','content-type':'application/json','content-encoding':'gzip'},body:compressed});
    assert.equal(reply.status,200);assert.equal(reply.headers.get('x-fixture-id'),'preserved');
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()),payload);
    assert.equal(received.length,1);assert.equal(received[0].url,'/v1/responses?api-version=fixture');
    assert.equal(received[0].headers.authorization,'Bearer fixture-private-key');
    assert.equal(received[0].headers['content-encoding'],undefined);
    assert.equal(received[0].body.model,'original-model');assert.deepEqual(received[0].body.reasoning,{effort:'xhigh'});
    assert.equal(received[0].body.input[0].role,'user');
    const regular={input:[{type:'function_call_output',call_id:'call_real',output:'ok'}]};
    await (await fetch(base+'/fixture-route/responses/compact',{method:'POST',body:JSON.stringify(regular)})).text();
    assert.deepEqual(received[1].body,regular);assert.equal(received[1].url,'/v1/responses/compact');
    const denied=await fetch(base+'/wrong-route/responses',{method:'POST',body:'{}'});assert.equal(denied.status,404);
    assert.equal(received.length,2);
    const health=await fetch(base+'/health/fixture-instance');assert.equal((await health.json()).instanceId,'fixture-instance');
  }finally{await close(proxy);await close(upstream);}
});

test('upstream failures are returned once, with no automatic model retry or request logging',async()=>{
  let calls=0;const upstream=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"fixture rejected"}');});
  const origin=await listen(upstream);
  const proxy=createResponsesCompatServer({instanceId:'instance',allowTestHttp:true,getRoutes:()=>[{token:'route',upstream:origin}]});
  const base=await listen(proxy);
  try{const r=await fetch(base+'/route/responses',{method:'POST',body:'{"input":[]}'});assert.equal(r.status,400);assert.equal(await r.text(),'{"error":"fixture rejected"}');assert.equal(calls,1);}
  finally{await close(proxy);await close(upstream);}
});

test('provider edits preserve all credentials, comments and other settings and can restore the exact endpoint',async()=>{
  const home=path.join(folder,'config-home');fs.mkdirSync(home);
  const file=path.join(home,'config.toml');
  const original='model_provider = "custom"\r\nmodel = "keep-model"\r\n[model_providers.custom]\r\nname = "Original"\r\nbase_url  = \'https://example.invalid/v1/\' # keep this comment\r\nwire_api = "responses"\r\nexperimental_bearer_token = "fixture-private-key"\r\n[features]\r\napps = true\r\n';
  fs.writeFileSync(file,original);
  const config=req=>providerConfig(req,{codexHome:home});
  const catalog=await config({action:'list'});
  assert.equal(catalog.activeProvider,'custom');assert.ok(!JSON.stringify(catalog).includes('fixture-private-key'));
  const backup=path.join(folder,'backup.toml');
  await config({action:'update',providerId:'custom',expected:'https://example.invalid/v1/',replacement:'http://127.0.0.1:12345/fixture',backupPath:backup});
  const changed=fs.readFileSync(file,'utf8');assert.ok(changed.includes('# keep this comment\r\n'));
  assert.equal(changed.replace('"http://127.0.0.1:12345/fixture"',"'https://example.invalid/v1/'"),original);
  assert.equal(fs.readFileSync(backup,'utf8'),original);
  await assert.rejects(config({action:'update',providerId:'custom',expected:'https://different.invalid/',replacement:'no',backupPath:path.join(folder,'no-backup.toml')}));
  assert.equal(fs.readFileSync(file,'utf8'),changed);
  await config({action:'update',providerId:'custom',expected:'http://127.0.0.1:12345/fixture',replacement:'https://example.invalid/v1/',backupPath:path.join(folder,'restore-backup.toml')});
  assert.equal((await config({action:'list'})).providers[0].baseUrl,'https://example.invalid/v1/');
});

test('enabling and disabling compat is transactional; a failed daemon never changes a provider endpoint',async()=>{
  const bundle=path.join(root,'dist');
  let endpoint='https://example.invalid/v1/';const updates=[];const startups=[];
  const config=async request=>{
    if(request.action==='list')return {activeProvider:'custom',providers:[{id:'custom',baseUrl:endpoint,wireApi:'responses'}]};
    assert.equal(request.expected,endpoint);updates.push(request);endpoint=request.replacement;return {updated:true};
  };
  const options={bundleDir:bundle,desktopPipePath:'desktop-before-setup',config,startup:async value=>startups.push(value),ensure:async()=>{throw new Error('Unavailable daemon');}};
  await assert.rejects(configureResponsesCompat({providerId:'custom',enabled:true},options),/Unavailable/);
  assert.equal(updates.length,0);assert.equal(endpoint,'https://example.invalid/v1/');assert.equal(readJson('responses-compat.json',{}).routes,undefined);
  options.ensure=async()=>({port:32109});
  await configureResponsesCompat({providerId:'custom',enabled:true},options);
  const route=readJson('responses-compat.json',{}).routes[0];
  assert.equal(endpoint,route.baseUrl);assert.equal(route.restartRequiredForPipe,'desktop-before-setup');
  await assert.rejects(prepareNewThreadCompat({desktopPipePath:'desktop-before-setup',config,ensure:options.ensure}),/重启/);
  await prepareNewThreadCompat({desktopPipePath:'desktop-after-restart',config,ensure:options.ensure});
  await configureResponsesCompat({providerId:'custom',enabled:false},options);
  assert.equal(endpoint,'https://example.invalid/v1/');assert.equal(startups.at(-1),false);
  await prepareNewThreadCompat({config,configure:()=>assert.fail('Explicitly disabled compatibility must remain disabled')});
});

test('automatic first-time setup stops before creation and never sends or queues the user task',async()=>{
  writeJson('responses-compat.json',{});let configured=0;
  const options={desktopPipePath:'genuine-before-restart',config:async()=>({activeProvider:'custom',providers:[{id:'custom',baseUrl:'https://example.invalid/v1/',wireApi:'responses'}]}),
    configure:async()=>{configured++;},ensure:async()=>assert.fail('No model requests')};
  await assert.rejects(prepareNewThreadCompat(options),error=>error.notSent===true && /尚未创建会话、尚未发送任务/.test(error.message));
  assert.equal(configured,1);
  await prepareNewThreadCompat({config:async()=>({activeProvider:'openai',providers:[]}),configure:()=>assert.fail('OpenAI config must stay unchanged')});
});

test('native create cannot run when preparation fails or channel authorization is revoked during preparation',async()=>{
  for(const failSetup of [true,false]){
    let authorized=true;let requests=0;
    const desktop=new DesktopClient({pipePath:'genuine-host',threadId:'genuine-source'}, {beforeCreateThread:async()=>{
      if(failSetup)throw Object.assign(new Error('Restart required, nothing created'),{notSent:true});authorized=false;
    }});
    desktop.request=async()=>{requests++;return {};};
    try{await assert.rejects(desktop.call('create_thread',{prompt:'任务，保留原文',target:{type:'projectless'}},{beforeSend:()=>{if(!authorized)throw new Error('Revoked');}}));assert.equal(requests,0);}
    finally{desktop.close();}
  }
});

test('HTTP-local and WebSocket provider configurations are not rewritten by automatic preparation',async()=>{
  writeJson('responses-compat.json',{});
  for(const provider of [
    {id:'local',baseUrl:'http://127.0.0.1:11434/v1/',wireApi:'responses'},
    {id:'ws',baseUrl:'https://example.invalid/v1/',wireApi:'responses',supportsWebsockets:true}
  ])await prepareNewThreadCompat({config:async()=>({activeProvider:provider.id,providers:[provider]}),configure:()=>assert.fail('Unsupported provider must remain unchanged')});
});

test('packaged independent compat process starts once on loopback and exits after all routes are disabled',async()=>{
  writeJson('responses-compat.json',{instanceId:'packaged-fixture',routes:[{providerId:'custom',token:'fixture',upstream:'https://example.invalid/v1/'}]});
  syncResponsesCompatRuntime(path.join(root,'dist'));
  const statuses=await Promise.all([ensureResponsesCompat(),ensureResponsesCompat()]);
  assert.equal(statuses[0].pid,statuses[1].pid);assert.ok(statuses[0].port>0);
  writeJson('responses-compat.json',{instanceId:'packaged-fixture',routes:[]});
  for(let index=0;index<60 && readJson('responses-compat-status.json',{}).state!=='stopped';index++)await delay(100);
  assert.equal(readJson('responses-compat-status.json',{}).state,'stopped');
});

test.after(()=>{
  const status=readJson('responses-compat-status.json',{});if(status.state==='running'){try{process.kill(status.pid);}catch{}}
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-responses-compat-test-'));
  fs.rmSync(folder,{recursive:true,force:true});
});
