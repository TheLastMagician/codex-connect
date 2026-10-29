import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dashboard-test-'));process.env.FEISHU_CODEX_DATA_DIR=folder;
delete process.env.FEISHU_APP_ID;delete process.env.FEISHU_APP_SECRET;
const {readJson,writeJson}=await import('../src/storage.mjs');
const {createDashboard}=await import('../src/dashboard.mjs');
const {settingsRequest}=await import('../src/settings-panel.mjs');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let changes=0,qrCalls=0;
const desktop={call:async(name)=>name==='list_projects'?{projects:[{projectId:'p',label:'项目一',projectKind:'local'}]}:{threads:[{id:'recent',title:'最近会话',kind:'codex',hostId:'local',projectId:'p'}]}};
const dashboard=await createDashboard({desktop,port:0,bundleDir:path.join(root,'dist'),onChange:()=>{changes++;},getStatus:()=>({state:'running',version:'fixture',desktopConnected:true}),
  localThreads:async()=>Array.from({length:75},(_,i)=>({id:'chat-'+i,title:'历史会话 '+i,kind:'codex',hostId:'local',projectId:'p'})),
  wechat:{status:()=>readJson('qr-fixture.json',{status:'not_started'}),begin:async()=>{qrCalls++;},verify:()=>{},disconnect:()=>{}}});
const origin=dashboard.baseUrl.slice(0,-1),token=readJson('dashboard.json',{}).token;let cookie,csrf;
async function request(route,method='GET',value,headers={}){return fetch(origin+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:origin,'Content-Type':'application/json','X-Codex-Csrf':csrf||''}:{}),...headers},...(value!==undefined?{body:JSON.stringify(value)}:{})});}
test.after(async()=>{await dashboard.close();assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-dashboard-test-'));fs.rmSync(folder,{recursive:true,force:true});});
test('loopback shell requires local authorization; host spoofing and cross-site requests are rejected',async()=>{
  assert.equal((await request('/')).status,200);assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/session','POST',{token},{Origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/session','POST',{token:'wrong'})).status,401);
  const spoofed=await new Promise((resolve,reject)=>{const req=http.get(origin+'/api/state',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);});assert.equal(spoofed,403);
  assert.equal((await request('/api/state','GET',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  const login=await request('/api/session','POST',{token});cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);csrf=(await login.json()).csrf;
});
test('API redacts saved credentials, refuses CSRF and unknown fields, and returns the complete actual local catalog',async()=>{
  writeJson('config.json',{appId:'cli_0000000000000004',appSecret:'never-echo-secret',allowedOpenIds:['paired']});writeJson('wechat.json',{enabled:true,token:'never-echo-wechat',botId:'bot',ownerUserId:'owner'});
  const response=await request('/api/state'),body=await response.text();assert.ok(!body.includes('never-echo'));assert.ok(body.includes('secretConfigured'));assert.ok(!body.includes(token));
  assert.equal((await request('/api/bots','POST',{}, {'X-Codex-Csrf':'wrong'})).status,403);
  assert.equal((await request('/api/bots','POST',{shell:'anything'})).status,400);
  const catalog=await (await request('/api/catalog')).json();assert.equal(catalog.threads.length,76);assert.equal(catalog.complete,true);
});
test('fixed bindings are resolved from real metadata; fabricated targets and remote execution routes are unavailable',async()=>{
  const input={name:'聊天机器人',appId:'cli_0000000000000005',appSecret:'another-secret',mode:'fixed',thread:{id:'invented',hostId:'local'}};
  assert.equal((await request('/api/bots','POST',input)).status,400);
  input.thread.id='chat-74';const response=await request('/api/bots','POST',input);assert.equal(response.status,200);const {bot}=await response.json();assert.equal(bot.thread.title,'历史会话 74');assert.ok(!JSON.stringify(bot).includes('another-secret'));
  const updated=await request('/api/bots','PUT',{id:bot.id,enabled:false,accessMode:'feishu'});assert.equal(updated.status,200);assert.equal((await updated.json()).bot.accessMode,'feishu');
  assert.equal((await request('/api/bots','PUT',{id:bot.id,mode:'full',accessMode:'feishu'})).status,400);
  assert.equal(readJson('feishu-bots.json',{}).bots[0].appSecret,'another-secret');
  assert.equal((await request('/api/send_message_to_thread','POST',{})).status,404);assert.equal((await request('/api/shell','POST',{})).status,404);assert.ok(changes>=2);
});
test('QR operations are explicit and file serving is limited to the current valid login',async()=>{
  await request('/api/state');assert.equal(qrCalls,0);
  assert.equal((await request('/api/wechat/login','POST',{})).status,200);assert.equal(qrCalls,1);
  writeJson('qr-fixture.json',{status:'wait',loginId:'00000000-0000-0000-0000-000000000001',expiresAt:Date.now()+60000,qrPath:path.join(root,'package.json')});
  assert.equal((await request('/api/wechat/qr')).status,400);
  const qrPath=path.join(folder,'wechat-login-00000000-0000-0000-0000-000000000001.png');fs.writeFileSync(qrPath,'fixture-png');
  writeJson('qr-fixture.json',{status:'wait',loginId:'00000000-0000-0000-0000-000000000001',expiresAt:Date.now()+60000,qrPath});assert.equal((await request('/api/wechat/qr')).status,200);
  writeJson('qr-fixture.json',{status:'expired',qrPath});assert.equal((await request('/api/wechat/qr')).status,400);
});

test('native panel uses the same protected settings API without exposing cookies, tokens or saved secrets',async()=>{
  const options={ready:async()=>{},read:()=>readJson('dashboard.json',{})};
  const state=await settingsRequest({route:'state'},options);
  assert.equal(state.version,'fixture');assert.equal(state.bots[0].secretConfigured,true);
  assert.doesNotMatch(JSON.stringify(state),/never-echo|another-secret/);assert.ok(!JSON.stringify(state).includes(token));
  await settingsRequest({route:'bots',method:'PUT',value:{id:'default',enabled:false}},options);
  assert.equal(readJson('config.json',{}).feishuEnabled,false);assert.equal(readJson('config.json',{}).appSecret,'never-echo-secret');
  const catalog=await settingsRequest({route:'catalog'},options);assert.equal(catalog.threads.length,76);
  const id='00000000-0000-0000-0000-000000000001';
  writeJson('qr-fixture.json',{status:'wait',loginId:id,expiresAt:Date.now()+60000,qrPath:path.join(folder,'wechat-login-'+id+'.png')});
  const qr=await settingsRequest({route:'wechat/qr'},options);assert.equal(qr.dataUrl,'data:image/png;base64,'+Buffer.from('fixture-png').toString('base64'));
  for(const input of [{route:'../../config.json'},{route:'https://attacker.example'},{route:'session',method:'POST',value:{}},{route:'send_message_to_thread',method:'POST',value:{}},
    {route:'state',method:'POST',value:{}},{route:'bots',method:'PUT',value:[]},{route:'state',token:'invented'}]) {
    await assert.rejects(settingsRequest(input,{ready:()=>assert.fail('Invalid actions must be rejected before contacting the service')}));
  }
});

test('native settings transport refuses redirects and sanitizes connection failures',async()=>{
  let captured;
  await assert.rejects(settingsRequest({route:'state'},{ready:async()=>{},read:()=>readJson('dashboard.json',{}),fetcher:async(url,options)=>{
    captured={url,options};throw Error('raw private token '+token);
  }}),error=>!error.message.includes(token));
  assert.equal(captured.options.redirect,'error');assert.equal(new URL(captured.url).hostname,'127.0.0.1');
});
