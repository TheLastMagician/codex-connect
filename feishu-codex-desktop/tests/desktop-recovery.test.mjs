import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {DesktopClient,encodeFrame} from '../src/desktop.mjs';
import {recoverDesktopContext} from '../src/desktop-context.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-caller-recovery-'));
process.env.FEISHU_CODEX_DATA_DIR=folder;
const {readJson,writeJson}=await import('../src/storage.mjs');
const {rememberDesktopContext,publishDesktopContext}=await import('../src/desktop-context-store.mjs');
const {FixedChatRouter}=await import('../src/fixed-router.mjs');
test.after(()=>{assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-caller-recovery-'));fs.rmSync(folder,{recursive:true,force:true});});

const oldSource='host-supplied-expired',healthy='host-supplied-loaded';
const ok=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
const unloaded=id=>({success:false,contentItems:[{type:'inputText',text:`thread not loaded: ${id}`} ]});
async function host({readTarget=()=>ok({thread:{status:{type:'idle'}},turns:[]}),failMutation=false,opaqueCallerFailure=false}={}) {
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\caller-recovery-${randomUUID()}`:path.join(folder,randomUUID()+'.sock');
  const calls=[],sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4){
        const size=buffer.readUInt32LE(0),request=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);calls.push(request);
        let result;
        if(request.method==='tools/list')result={tools:['read_thread','list_threads'].map(name=>({namespace:'codex_app',name}))};
        else if(request.params.threadId===oldSource || failMutation && request.params.tool==='create_thread')result=opaqueCallerFailure
          ?{success:false,contentItems:[{type:'inputText',text:'Codex app tool request failed'}]}:unloaded(request.params.threadId);
        else if(request.params.tool==='read_thread' && request.params.arguments.threadId==='destination')result=readTarget();
        else result=ok({thread:{status:{type:'idle'}},turns:[]});
        socket.write(encodeFrame({jsonrpc:'2.0',id:request.id,result}));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  return {pipe,calls,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
function clientFor(h,{saved={pipePath:h.pipe,threadId:oldSource},bindings=[{pipePath:h.pipe,threadId:healthy}]}={}) {
  const published=[];let recoveries=0;
  const client=new DesktopClient({pipePath:h.pipe,threadId:oldSource},{resolveContext:async(current,{probe})=>{
    recoveries++;return recoverDesktopContext(current,{probe,read:()=>saved,readBindings:()=>bindings,publish:context=>published.push(context),discover:()=>assert.fail('Healthy host-provided backup must avoid discovery')});
  }});
  return {client,published,recoveries:()=>recoveries};
}

test('an unloaded caller on a live pipe recovers using verified history while preserving the destination',async()=>{
  const h=await host({readTarget:()=>ok({thread:{id:'destination'},turns:[{id:'original-turn',status:'completed'}]})}),f=clientFor(h);
  try {
    const result=await f.client.call('read_thread',{threadId:'destination',turnLimit:10});
    assert.equal(result.turns[0].status,'completed');assert.equal(f.recoveries(),1);assert.equal(f.published[0].threadId,healthy);
    const reads=h.calls.filter(c=>c.params?.arguments?.threadId==='destination');
    assert.deepEqual(reads.map(c=>c.params.threadId),[oldSource,healthy]);
    assert.ok(h.calls.every(c=>c.method==='tools/list'||['read_thread','list_threads'].includes(c.params.tool)));
    assert.equal(f.client.lastRecovery.reason,'caller_unloaded');
  }finally{f.client.close();await h.close();}
});

test('a refreshed host caller on the same pipe is reused and health probes follow the recovered caller',async()=>{
  const h=await host(),f=clientFor(h,{saved:{pipePath:h.pipe,threadId:healthy},bindings:[]});
  try {
    await f.client.probe();assert.equal(f.client.context.threadId,healthy);
    const last=h.calls.at(-1);assert.equal(last.params.threadId,healthy);assert.equal(last.params.arguments.threadId,healthy);
    assert.equal(f.recoveries(),1);
  }finally{f.client.close();await h.close();}
});

test('concurrent failed reads share one recovery and recheck authorization before the retry',async()=>{
  const h=await host(),f=clientFor(h);let checks=0;
  try {
    await Promise.all([f.client.call('list_threads',{}, {beforeSend:()=>checks++}),f.client.call('list_projects',{}, {beforeSend:()=>checks++})]);
    assert.equal(f.recoveries(),1);assert.equal(checks,4);
    assert.equal(h.calls.filter(c=>c.method==='tools/list').length,1);
    f.client.updateContext({pipePath:h.pipe,threadId:oldSource});let authorized=true;
    f.client.resolveContext=async()=>{authorized=false;return {pipePath:h.pipe,threadId:healthy};};
    await assert.rejects(f.client.call('list_projects',{}, {beforeSend:()=>{if(!authorized)throw Error('revoked');}}),/revoked/);
  }finally{f.client.close();await h.close();}
});

test('a missing destination is not treated as a failed caller and mutations are never replayed',async()=>{
  const h=await host({readTarget:()=>unloaded('destination'),failMutation:true}),f=clientFor(h);
  try {
    f.client.updateContext({pipePath:h.pipe,threadId:healthy});
    await assert.rejects(f.client.call('read_thread',{threadId:'destination'}),/thread not loaded: destination/);assert.equal(f.recoveries(),0);
    await assert.rejects(f.client.call('create_thread',{prompt:'must not replay'}),/thread not loaded/);
    assert.equal(f.recoveries(),0);assert.equal(h.calls.filter(c=>c.params?.tool==='create_thread').length,1);
  }finally{f.client.close();await h.close();}
});

test('failed recovery is throttled until a new genuine binding arrives',async()=>{
  const h=await host(),client=new DesktopClient({pipePath:h.pipe,threadId:oldSource},{resolveContext:async()=>{throw Error('no healthy caller');}});
  try {
    await assert.rejects(client.call('read_thread',{threadId:'destination'}),/连接暂不可用/);
    await assert.rejects(client.call('read_thread',{threadId:'destination'}),/连接暂不可用/);assert.equal(h.calls.length,1);
    client.updateContext({pipePath:h.pipe,threadId:healthy});await client.call('read_thread',{threadId:'destination'});assert.equal(h.calls.length,2);
  }finally{client.close();await h.close();}
});

test('an explicitly closed client cannot reconnect after a delayed caller recovery',async()=>{
  const h=await host();let release,started;
  const pending=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>started=resolve);
  const client=new DesktopClient({pipePath:h.pipe,threadId:oldSource},{resolveContext:async()=>{started();await pending;return {pipePath:h.pipe,threadId:healthy};}});
  try {
    const work=client.call('list_projects');await seen;client.close();release();
    await assert.rejects(work,/连接暂不可用/);assert.equal(client.context.threadId,oldSource);assert.equal(h.calls.length,1);
  }finally{client.close();await h.close();}
});

test('a newer host-supplied binding wins while a historical candidate is being verified',async()=>{
  const current={pipePath:'same-host',threadId:oldSource},newer={pipePath:'same-host',threadId:'new-host-caller'};let reads=0;
  const result=await recoverDesktopContext(current,{read:()=>++reads===1?current:newer,readBindings:()=>[{pipePath:'same-host',threadId:healthy}],probe:async()=>{},publish:()=>assert.fail('Cannot replace the newer host binding'),discover:()=>assert.fail('No endpoint discovery needed')});
  assert.deepEqual(result,newer);
});

test('verified context history is bounded, deduplicated, private and strips unrelated metadata',()=>{
  writeJson('desktop-contexts.json',{bindings:Array.from({length:20},(_,i)=>({pipePath:'host-pipe',threadId:'genuine-'+i}))});
  publishDesktopContext({pipePath:'host-pipe',threadId:'genuine-19'});
  rememberDesktopContext({pipePath:'host-pipe',threadId:'genuine-3',unrelated:'do not store'});
  const saved=readJson('desktop-contexts.json',{}).bindings;assert.equal(saved.length,16);assert.equal(saved[0].threadId,'genuine-3');
  assert.ok(saved.every(context=>Object.keys(context).sort().join(',')==='pipePath,threadId'));
  assert.equal(readJson('desktop-context.json',{}).threadId,'genuine-19');
  publishDesktopContext({pipePath:'host-pipe',threadId:'older-probe-result'},{expected:{pipePath:'host-pipe',threadId:'genuine-1'}});
  assert.equal(readJson('desktop-context.json',{}).threadId,'genuine-19','A late probe must not replace a newer host binding');
});

test('an opaque desktop failure recovers only when a separate caller probe also fails',async()=>{
  const h=await host({opaqueCallerFailure:true}),f=clientFor(h);
  try {
    await f.client.call('read_thread',{threadId:'destination'});assert.equal(f.recoveries(),1);
    assert.equal(f.client.lastRecovery.reason,'caller_unavailable');
    assert.ok(h.calls.some(c=>c.params?.arguments?.threadId===oldSource),'Must independently check the failing caller');
  }finally{f.client.close();await h.close();}
  const next=await host({readTarget:()=>({success:false,contentItems:[{type:'inputText',text:'Codex app tool request failed'}]})}),g=clientFor(next);
  try {
    g.client.updateContext({pipePath:next.pipe,threadId:healthy});
    await assert.rejects(g.client.call('read_thread',{threadId:'destination'}),/Codex app tool request failed/);assert.equal(g.recoveries(),0);
  }finally{g.client.close();await next.close();}
});

test('recovery returns the original completed reply even with a newer desktop turn and does not replay input',async()=>{
  const h=await host({readTarget:()=>ok({thread:{status:{type:'active'}},turns:[
    {id:'desktop-manual-turn',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'desktop task'}]}]},
    {id:'feishu-original-turn',status:'completed',items:[{type:'agentMessage',id:'feishu-answer',text:'original Feishu answer'}]}
  ]})}),f=clientFor(h),sent=[];
  const message={id:'original-message',chatId:'original-group',openId:'original-user',timestamp:Date.now(),text:'original task',chatType:'group'};
  const state={sessions:{},seen:{},fixedQueue:{pending:[{...message,id:'later-message',text:'queued task'}],active:{message,phase:'waiting',turnId:'feishu-original-turn',clientUserMessageId:randomUUID(),sentAt:Date.now()-60000},review:[],deliveries:[]}};
  const router=new FixedChatRouter({desktop:f.client,thread:{id:'destination',hostId:'local'},state,saveState:()=>{},getConfig:()=>({allowedOpenIds:['original-user']}),isAuthorized:()=>true,send:async(chat,text,meta)=>{sent.push({chat,text,meta});}});
  try {
    await router.poll();await router.deliveryWork;
    const answer=sent.find(s=>s.meta.kind==='assistant');assert.equal(answer.text,'original Feishu answer');assert.equal(answer.chat,'original-group');
    assert.deepEqual(answer.meta.replyOpenIds,['original-user']);assert.equal(state.fixedQueue.pending.length,1);assert.equal(state.fixedQueue.active,null);
    assert.ok(h.calls.every(c=>c.method==='tools/list'||c.params.tool==='read_thread'));
  }finally{router.stop();f.client.close();await h.close();}
});
