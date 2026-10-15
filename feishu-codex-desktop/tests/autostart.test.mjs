import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-autostart-test-'));
process.env.FEISHU_CODEX_DATA_DIR=path.join(folder,'private');
const home=path.join(folder,'codex'),bundles=path.join(folder,'bundles');
const children=new Set();
fs.mkdirSync(bundles,{recursive:true});fs.mkdirSync(home,{recursive:true});
const {readJson,writeJson,dataDir}=await import('../src/storage.mjs');
const {configureAutostart,autostartStatus,autostartEntry,syncAutostartRuntime}=await import('../src/autostart-settings.mjs');
const {ensureBridge,desktopContext,pauseAutostart,alive}=await import('../src/bridge-lifecycle.mjs');
const {DesktopClient,encodeFrame}=await import('../src/desktop.mjs');
const fakeBridge=`const fs=require('node:fs'),path=require('node:path'),dir=process.env.FEISHU_CODEX_DATA_DIR;
fs.appendFileSync(path.join(dir,'launches.txt'),'started\\n');
fs.writeFileSync(path.join(dir,'bridge.lock'),JSON.stringify({pid:process.pid}));
fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({pid:process.pid,state:'running'}));
setInterval(()=>{},1000);`;
fs.writeFileSync(path.join(bundles,'bridge.cjs'),fakeBridge);
fs.writeFileSync(path.join(bundles,'catalog.py'),'# test fixture');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.copyFileSync(path.join(root,'dist/autostart.cjs'),path.join(bundles,'autostart.cjs'));
for(const name of ['responses-compat-daemon.cjs','provider-config.py','discover-desktop.ps1','wechat-auth-worker.cjs','dashboard.html','dashboard.js','dashboard.css','dashboard-icon.png'])fs.copyFileSync(path.join(root,'dist',name),path.join(bundles,name));
const validate=async()=>{};
const options={entryPath:path.join(bundles,'bridge.cjs'),validate};
async function stopChildren() {
  const running=readJson('bridge.lock',{}).pid;if(running)children.add(running);
  for(const pid of children){try{process.kill(pid);}catch{}}
  for(let i=0;i<500 && [...children].some(alive);i++)await delay(10);
  assert.ok(![...children].some(alive),'Fixture processes must exit before deleting their files');
  children.clear();
}
test.beforeEach(async()=>{
  await stopChildren();
  if(fs.existsSync(dataDir))fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:15,retryDelay:25});
  fs.mkdirSync(dataDir,{recursive:true});
  writeJson('config.json',{appId:'fixture-app',appSecret:'fixture-secret'});
  fs.writeFileSync(path.join(home,'hooks.json'),JSON.stringify({description:'Existing user hooks',hooks:{
    SessionStart:[{matcher:'resume',hooks:[{type:'command',command:'existing-user-command'}]}],
    Stop:[{hooks:[{type:'command',command:'existing-stop-command'}]}]}}));
});
test.after(async()=>{
  await stopChildren();
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-autostart-test-'));
  fs.rmSync(folder,{recursive:true,force:true,maxRetries:15,retryDelay:25});
});

test('autostart is opt-in and installing it preserves other hooks; repeated enable and disable are reversible',()=>{
  assert.equal(autostartStatus({codexHome:home}).enabled,false);
  const original=JSON.parse(fs.readFileSync(path.join(home,'hooks.json'),'utf8'));
  for(let i=0;i<2;i++){
    const result=configureAutostart(true,{bundleDir:bundles,codexHome:home});
    assert.equal(result.enabled,true);assert.equal(result.hookRegistered,true);assert.equal(result.requiresHookTrust,true);
  }
  const hooks=JSON.parse(fs.readFileSync(path.join(home,'hooks.json'),'utf8'));
  assert.equal(hooks.hooks.SessionStart.length,2);
  assert.deepEqual(hooks.hooks.SessionStart[0],original.hooks.SessionStart[0]);
  assert.deepEqual(hooks.hooks.Stop,original.hooks.Stop);
  assert.ok(fs.existsSync(autostartEntry()));
  assert.equal(configureAutostart(false,{codexHome:home}).enabled,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'hooks.json'),'utf8')),original);
});

test('malformed existing hook configuration is not overwritten',()=>{
  const file=path.join(home,'hooks.json');fs.writeFileSync(file,'{ broken');
  assert.throws(()=>configureAutostart(true,{bundleDir:bundles,codexHome:home}),/未修改/);
  assert.equal(fs.readFileSync(file,'utf8'),'{ broken');assert.deepEqual(readJson('autostart.json',{}),{});
});

test('disabled or unconfigured automatic startup does not connect or launch',async()=>{
  const context={pipePath:'host-pipe',threadId:'real-source'};
  const never=()=>assert.fail('Must not contact desktop');
  assert.deepEqual(await ensureBridge(context,{...options,automatic:true,validate:never}),{skipped:'disabled'});
  writeJson('autostart.json',{enabled:true});writeJson('config.json',{});
  assert.deepEqual(await ensureBridge(context,{...options,automatic:true,validate:never}),{skipped:'not_configured'});
  assert.equal(fs.existsSync(path.join(dataDir,'launches.txt')),false);
});

test('a stale desktop context cannot be published or used to launch the bridge',async()=>{
  const original={pipePath:'old-pipe',threadId:'genuine-source'};writeJson('desktop-context.json',original);
  await assert.rejects(ensureBridge({pipePath:'unavailable-pipe',threadId:'new-source'},
    {...options,validate:async()=>{throw new Error('Host unavailable');}}),/unavailable/);
  assert.deepEqual(readJson('desktop-context.json',{}),original);
  assert.equal(fs.existsSync(path.join(dataDir,'launches.txt')),false);
  assert.equal(fs.existsSync(path.join(dataDir,'bridge-start.lock')),false);
});
test('disabling autostart while its desktop probe is pending prevents the delayed launch',async()=>{
  writeJson('autostart.json',{enabled:true});
  const result=await ensureBridge({pipePath:'host-pipe',threadId:'genuine-source'},{...options,automatic:true,
    validate:async()=>{writeJson('autostart.json',{enabled:false});}});
  assert.deepEqual(result,{skipped:'disabled'});
  assert.equal(fs.existsSync(path.join(dataDir,'launches.txt')),false);
  assert.equal(fs.existsSync(path.join(dataDir,'desktop-context.json')),false);
});

test('concurrent startup attempts launch a single bridge and retain its real context',async()=>{
  const context={pipePath:'host-pipe',threadId:'genuine-source'};
  const results=await Promise.all(Array.from({length:5},()=>ensureBridge(context,options)));
  children.add(results[0].pid);
  assert.equal(new Set(results.map(r=>r.pid)).size,1);
  assert.equal(results.filter(r=>r.startedProcess).length,1);
  assert.equal(fs.readFileSync(path.join(dataDir,'launches.txt'),'utf8'),'started\n');
  assert.deepEqual(readJson('desktop-context.json',{}),context);
  const next={pipePath:'new-desktop-pipe',threadId:'resumed-source'};
  const rebound=await ensureBridge(next,options);
  assert.equal(rebound.alreadyRunning,true);assert.equal(rebound.pid,results[0].pid);
  assert.deepEqual(readJson('desktop-context.json',{}),next);
});

test('startup publishes the recovered host context instead of restoring a stale inherited pipe',async()=>{
  const stale={pipePath:'old-inherited-pipe',threadId:'old-real-source'};
  const verified={pipePath:'new-verified-pipe',threadId:'new-real-source'};
  const result=await ensureBridge(stale,{...options,validate:async()=>verified});children.add(result.pid);
  assert.deepEqual(readJson('desktop-context.json',{}),verified);
});

test('a manual stop pauses the current desktop only and updating the runtime does not clear the pause',async()=>{
  configureAutostart(true,{bundleDir:bundles,codexHome:home});
  const context={pipePath:'host-pipe',threadId:'genuine-source'};writeJson('desktop-context.json',context);
  pauseAutostart();syncAutostartRuntime(bundles);
  assert.equal(autostartStatus({codexHome:home}).pausedForCurrentDesktop,true);
  assert.deepEqual(await ensureBridge(context,{...options,automatic:true}),{skipped:'paused'});
  const restarted=await ensureBridge({...context,pipePath:'restarted-host-pipe'},{...options,automatic:true});
  children.add(restarted.pid);assert.equal(restarted.startedProcess,true);
  assert.equal(autostartStatus({codexHome:home}).pausedForCurrentDesktop,false);
});

test('only host-supplied hook and MCP context replaces a saved genuine source',()=>{
  const saved={pipePath:'saved-host',threadId:'saved-source'};
  assert.deepEqual(desktopContext(undefined,{env:{},saved}),saved);
  assert.deepEqual(desktopContext(undefined,{env:{CODEX_APP_TOOLS_PIPE_PATH:'new-host'},event:{session_id:'hook-source'},saved}),
    {pipePath:'new-host',threadId:'hook-source'});
  assert.deepEqual(desktopContext({_meta:{'x-codex-turn-metadata':JSON.stringify({thread_id:'mcp-source'})}},
    {env:{CODEX_APP_TOOLS_PIPE_PATH:'new-host'},saved}),{pipePath:'new-host',threadId:'mcp-source'});
});

async function nativeHost() {
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\autostart-host-test-${randomUUID()}`:path.join(folder,randomUUID()+'.sock');
  const calls=[],sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4){
        const size=buffer.readUInt32LE(0),request=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
        calls.push(request);socket.write(encodeFrame({jsonrpc:'2.0',id:request.id,result:{success:true,
          contentItems:[{type:'inputText',text:'{"threads":[]}'}]}}));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  return {pipe,calls,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
async function runHook(event,env={}) {
  const child=spawn(process.execPath,[autostartEntry()],{windowsHide:true,env:{...process.env,
    CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:'',...env},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.stdin.end(JSON.stringify(event));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,stderr);assert.equal(stdout,'');return readJson('autostart-status.json',{});
}
test('the packaged startup hook starts once with a real desktop source and never sends tasks',async()=>{
  configureAutostart(true,{bundleDir:bundles,codexHome:home});const host=await nativeHost();
  try {
    const result=await runHook({hook_event_name:'SessionStart',source:'resume',session_id:'actual-hook-session'},
      {CODEX_APP_TOOLS_PIPE_PATH:host.pipe});
    children.add(readJson('bridge.lock',{}).pid);assert.equal(result.state,'started');
    assert.equal(host.calls.length,1);assert.equal(host.calls[0].params.threadId,'actual-hook-session');
    assert.equal(host.calls[0].params.tool,'list_threads');
    await runHook({hook_event_name:'SessionStart',source:'resume',session_id:'another-real-session'},
      {CODEX_APP_TOOLS_PIPE_PATH:host.pipe});
    assert.equal(fs.readFileSync(path.join(dataDir,'launches.txt'),'utf8'),'started\n');
    assert.ok(host.calls.every(r=>r.params.tool==='list_threads'));
  }finally{await host.close();}
});
test('a non-desktop CLI hook cannot bind its session ID to the saved desktop pipe',async()=>{
  configureAutostart(true,{bundleDir:bundles,codexHome:home});
  const saved={pipePath:'saved-desktop',threadId:'saved-real-source'};writeJson('desktop-context.json',saved);
  const result=await runHook({hook_event_name:'SessionStart',source:'startup',session_id:'unrelated-cli-session'});
  assert.equal(result.state,'waiting_desktop');assert.deepEqual(readJson('desktop-context.json',{}),saved);
  assert.equal(fs.existsSync(path.join(dataDir,'launches.txt')),false);
});
test('rebinding a client survives old socket closure and keeps the same channel client object',async()=>{
  const first=await nativeHost(),second=await nativeHost();
  const client=new DesktopClient({pipePath:first.pipe,threadId:'old-genuine-source'});
  try {
    await client.call('list_threads',{limit:1});
    client.updateContext({pipePath:second.pipe,threadId:'new-genuine-source'});
    await client.call('list_threads',{limit:1});await delay(10);
    await client.call('list_threads',{limit:1});
    assert.equal(first.calls.length,1);assert.equal(second.calls.length,2);
    assert.ok(second.calls.every(r=>r.params.threadId==='new-genuine-source'));
    assert.equal(client.context.pipePath,second.pipe);
  }finally{client.close();await first.close();await second.close();}
});
test('the packaged MCP exposes autostart configuration and reports registration without claiming hook trust',async()=>{
  writeJson('config.json',{}); // Only the local dashboard starts; no real bot SDK connection.
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/server.cjs')],
    env:{...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_PIPE_PATH:'',CODEX_THREAD_ID:''},stderr:'pipe'});
  const client=new Client({name:'autostart-integration-test',version:'1'},{capabilities:{}});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;assert.ok(tools.some(tool=>tool.name==='configure_autostart'));assert.ok(tools.some(tool=>tool.name==='open_settings'));
    const result=await client.callTool({name:'configure_autostart',arguments:{enabled:true}});
    assert.ok(!result.isError);const configured=JSON.parse(result.content[0].text);
    assert.equal(configured.enabled,true);assert.equal(configured.hookRegistered,true);
    assert.equal(configured.requiresHookTrust,true);
    const status=await client.callTool({name:'bridge_status',arguments:{}});
    assert.equal(JSON.parse(status.content[0].text).autostart.enabled,true);
    assert.ok(!JSON.stringify(status).includes('fixture-secret'));
    await client.callTool({name:'configure_autostart',arguments:{enabled:false}});
    assert.equal(autostartStatus({codexHome:home}).enabled,false);
    assert.equal(fs.existsSync(path.join(dataDir,'launches.txt')),false);
  }finally{await client.close();}
});
