import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopWake,threadWakeUrl,openRegisteredThread} from '../src/desktop-wake.mjs';
import {DesktopClient,encodeFrame} from '../src/desktop.mjs';

const thread={id:'01a12472-4b57-7de1-84cb-47dbaa7a5e82',hostId:'local'};
const unavailable=()=>Object.assign(Error('Codex app tool request failed'),{rpcCode:-32000});
test('waking uses only a registered local conversation URL and never a shell or prompt',async()=>{
  assert.equal(threadWakeUrl(thread),`codex://threads/${thread.id}`);
  for(const bad of [{id:thread.id,hostId:'remote'},{id:'new'},{id:thread.id+'?prompt=task'},{id:'file:///anything'}])assert.equal(threadWakeUrl(bad),null);
  let invocation;
  await openRegisteredThread(threadWakeUrl(thread),{platform:'win32',launch:(command,args,options)=>{
    invocation={command,args,options};const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  assert.match(invocation.command,/explorer\.exe$/i);assert.deepEqual(invocation.args,[threadWakeUrl(thread)]);
  assert.equal(invocation.options.shell,undefined);assert.equal(invocation.options.windowsHide,true);
  await assert.rejects(openRegisteredThread('codex://threads/new?prompt=task',{platform:'win32',launch:()=>assert.fail('Invalid URI must not launch')}));
});
test('concurrent queues share one wake and further attempts respect cooldown and persisted decisions',async()=>{
  let time=100000,calls=0,decisions=0,release;const pending=new Promise(resolve=>release=resolve);
  const wake=new DesktopWake({platform:'win32',now:()=>time,open:async()=>{calls++;await pending;}});
  const options={authorize:()=>{},beforeWake:()=>{decisions++;return true;}};
  const a=wake.recover(thread,options),b=wake.recover(thread,options);await Promise.resolve();release();
  assert.deepEqual(await Promise.all([a,b]),[true,false]);assert.equal(calls,1);assert.equal(decisions,1);
  assert.equal(await wake.recover(thread,options),false);
  time+=60001;assert.equal(await wake.recover(thread,{...options,beforeWake:()=>false}),false);assert.equal(calls,1);
  assert.deepEqual(wake.lastAttempt,{at:100000,state:'requested'});
});
test('catalog failure on a live host permits waking; healthy catalogs and missing pipes never do',async()=>{
  const opened=[],wake=new DesktopWake({platform:'win32',open:async url=>opened.push(url)});
  const client=new DesktopClient({threadId:'real-host-caller'},{wakeDesktop:wake});let checks=0;
  const options={authorize:()=>checks++,beforeWake:()=>true};
  try {
    client.request=async()=>({tools:[]});assert.equal(await client.recoverForThread(thread,options),false);
    client.request=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};assert.equal(await client.recoverForThread(thread,options),false);
    client.request=async()=>{throw unavailable();};assert.equal(await client.recoverForThread(thread,options),true);
    assert.deepEqual(opened,[threadWakeUrl(thread)]);assert.ok(checks>=4);
  }finally{client.close();}
});
test('revocation or closing during the renderer probe prevents navigation',async()=>{
  for(const close of [false,true]) {
    const client=new DesktopClient({threadId:'real-host-caller'},{wakeDesktop:{recover:()=>assert.fail('Must not wake')}});let allowed=true;
    client.request=async()=>{if(close)client.close();else allowed=false;throw unavailable();};
    const action=()=>client.recoverForThread(thread,{authorize:()=>{if(!allowed)throw Error('revoked');},beforeWake:()=>true});
    try {if(close)assert.equal(await action(),false);else await assert.rejects(action(),/revoked/);}
    finally{client.close();}
  }
});
test('native generic error codes survive framing so destination failures cannot trigger arbitrary waking',async()=>{
  const client=new DesktopClient({threadId:'genuine'});let resolve,reject;
  const response=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  client.pending.set(7,{resolve,reject,timer:setTimeout(()=>{},1000)});
  client.onData(encodeFrame({id:7,error:{code:-32000,message:'Codex app tool request failed'}}));
  await assert.rejects(response,error=>error.rpcCode===-32000);client.close();
});
