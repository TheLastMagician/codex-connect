import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopClient,encodeFrame} from '../src/desktop.mjs';
import {recoverDesktopContext} from '../src/desktop-context.mjs';
test('native transport handles split/coalesced UTF-8 frames and keeps genuine caller context',async()=>{
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\feishu-test-${randomUUID()}`:path.join(os.tmpdir(),`feishu-${randomUUID()}.sock`);
  const server=net.createServer(socket=>{
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4) {
        const size=buffer.readUInt32LE(0);const request=JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4);
        assert.equal(request.params.threadId,'real-thread');assert.equal(request.params.namespace,'codex_app');
        const reply=encodeFrame({jsonrpc:'2.0',id:request.id,result:{success:true,contentItems:[{type:'inputText',text:'{"title":"真实会话"}'}]}});
        socket.write(reply.subarray(0,3));socket.write(reply.subarray(3));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  const client=new DesktopClient({pipePath:pipe,threadId:'real-thread'});
  try {
    const result=await Promise.all([client.call('list_threads'),client.call('read_thread',{threadId:'target'})]);
    assert.equal(result[0].title,'真实会话');assert.equal(result[1].title,'真实会话');
    await assert.rejects(client.call('shell_exec',{command:'anything'}),/不支持/);
  }finally {client.close();await new Promise(resolve=>server.close(resolve));}
});

function fixturePipe() {return process.platform==='win32'?`\\\\.\\pipe\\reconnect-test-${randomUUID()}`:path.join(os.tmpdir(),`reconnect-${randomUUID()}.sock`);}
async function reconnectHost({dropMutation=false}={}) {
  const pipe=fixturePipe(),calls=[],sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4) {
        const size=buffer.readUInt32LE(0),request=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);calls.push(request);
        if(dropMutation && request.params?.tool==='create_thread'){socket.destroy();return;}
        const result=request.method==='tools/list'?{tools:['list_threads','read_thread'].map(name=>({namespace:'codex_app',name}))}:
          {success:true,contentItems:[{type:'inputText',text:JSON.stringify(request.params.tool==='create_thread'?{threadId:'created'}:{threads:[]})}]};
        socket.write(encodeFrame({jsonrpc:'2.0',id:request.id,result}));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  return {pipe,calls,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}

test('a missing old pipe recovers before sending and uses the refreshed genuine caller exactly once',async()=>{
  const host=await reconnectHost();let recoveries=0;
  const saved={pipePath:host.pipe,threadId:'new-host-supplied-source'};
  const client=new DesktopClient({pipePath:fixturePipe(),threadId:'old-host-supplied-source'},{resolveContext:async(current,{probe})=>{
    recoveries++;return recoverDesktopContext(current,{probe,read:()=>saved,discover:()=>assert.fail('Valid saved binding must be reused')});
  }});
  try {
    const result=await client.call('create_thread',{prompt:'用户任务，保留原文',target:{type:'projectless'}});
    assert.equal(result.threadId,'created');assert.equal(recoveries,1);
    const mutations=host.calls.filter(call=>call.params?.tool==='create_thread');
    assert.equal(mutations.length,1);assert.equal(mutations[0].params.threadId,saved.threadId);
    assert.equal(mutations[0].params.arguments.prompt,'用户任务，保留原文');
    assert.ok(host.calls.filter(call=>call.params?.tool!=='create_thread').every(call=>call.method==='tools/list' || call.params.tool==='list_threads'));
  }finally{client.close();await host.close();}
});

test('recovery identifies the actual tool endpoint and never invents a caller or accepts ambiguous endpoints',async()=>{
  const saved={pipePath:'expired',threadId:'host-supplied-source'};const published=[];
  const endpoints=[{pipePath:'browser-only'},{pipePath:'actual-app-tools'}];
  const options={read:()=>saved,discover:async()=>endpoints,publish:context=>published.push(context),
    probe:async context=>{if(context.pipePath!=='actual-app-tools')throw new Error('Wrong tool catalog');}};
  assert.deepEqual(await recoverDesktopContext(saved,options),{pipePath:'actual-app-tools',threadId:saved.threadId});
  assert.equal(published.length,1);
  await assert.rejects(recoverDesktopContext(saved,{...options,probe:async()=>{}}),/连接暂不可用/);
  assert.equal(published.length,1);
  await assert.rejects(recoverDesktopContext({pipePath:'expired'},{...options,read:()=>({}),discover:()=>assert.fail('No genuine caller')}),/尚未发送/);
});

test('a newer verified host binding wins over an in-flight discovery result',async()=>{
  const saved={pipePath:'expired',threadId:'original-source'},newer={pipePath:'fresh-host',threadId:'fresh-source'};let reads=0;
  const result=await recoverDesktopContext(saved,{read:()=>++reads===1?saved:newer,
    discover:async()=>[{pipePath:'discovered-host'}],probe:async()=>{},publish:()=>assert.fail('Must not overwrite a newer host binding')});
  assert.deepEqual(result,newer);
});

test('unavailable desktop errors are actionable and never expose an expired native pipe path',async()=>{
  const pipe=fixturePipe();
  const client=new DesktopClient({pipePath:pipe,threadId:'genuine-source'},{resolveContext:async()=>{throw new Error('No active desktop');}});
  try{await assert.rejects(client.call('list_threads'),error=>error.notSent && error.code==='DESKTOP_DISCONNECTED' && !error.message.includes(pipe));}
  finally{client.close();}
});

test('a connection lost after writing a mutation never replays it through recovery',async()=>{
  const host=await reconnectHost({dropMutation:true});let recoveries=0;
  const client=new DesktopClient({pipePath:host.pipe,threadId:'genuine-source'},{resolveContext:async()=>{recoveries++;return {};}});
  try {
    await assert.rejects(client.call('create_thread',{prompt:'任务',target:{type:'projectless'}}));
    assert.equal(host.calls.filter(call=>call.params?.tool==='create_thread').length,1);assert.equal(recoveries,0);
  }finally{client.close();await host.close();}
});

test('channel authorization is rechecked after native connection recovery and before submitting a task',async()=>{
  const host=await reconnectHost();let authorized=true;
  const client=new DesktopClient({pipePath:fixturePipe(),threadId:'genuine-source'},{resolveContext:async()=>{
    authorized=false;return {pipePath:host.pipe,threadId:'genuine-source'};
  }});
  try {
    await assert.rejects(client.call('create_thread',{prompt:'任务',target:{type:'projectless'}},{beforeSend:()=>{if(!authorized)throw new Error('Revoked');}}),/Revoked/);
    assert.equal(host.calls.length,0);
  }finally{client.close();await host.close();}
});

test('native creation rechecks channel authorization after connecting and before writing',async()=>{
  const client=new DesktopClient({pipePath:'genuine-host',threadId:'real-thread'});
  let authorized=true,writes=0;
  client.connect=async()=>{
    authorized=false;
    client.socket={write:()=>{writes++;},destroy:()=>{}};
  };
  try {
    await assert.rejects(client.call('create_thread',{prompt:'任务',target:{type:'projectless'}},{
      beforeSend:()=>{if(!authorized)throw new Error('Channel authorization revoked');}
    }),/authorization revoked/);
    assert.equal(writes,0);assert.equal(client.pending.size,0);
  }finally{client.close();}
});
