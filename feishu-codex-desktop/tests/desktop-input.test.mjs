import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopInput} from '../src/desktop-input.mjs';
import {DesktopClient,encodeFrame} from '../src/desktop.mjs';

async function fixture(options={}) {
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\desktop-input-test-${randomUUID()}`:
    path.join(os.tmpdir(),`desktop-input-${randomUUID()}.sock`);
  const requests=[];const sockets=new Set();let ownerReady=options.ownerReady!==false;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE(0)+4) {
        const size=buffer.readUInt32LE(0);const request=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
        if(request.type!=='request')continue;
        requests.push(request);let response={type:'response',requestId:request.requestId,resultType:'success',method:request.method};
        if(request.method==='initialize')response.result={clientId:'server-assigned-client'};
        else {
          assert.equal(request.sourceClientId,'server-assigned-client');
          if(request.method==='thread-owner-discovery') {
            response=ownerReady?{...response,handledByClientId:'desktop-owner',result:{supportsUntrustedAppInput:true}}:
              {...response,resultType:'error',error:'no-client-found'};
          }else if(request.method==='thread-follower-start-turn') {
            if(options.dropStartAck)continue;
            response=options.rejectStart?{...response,resultType:'error',error:'request-failed'}:{...response,result:{result:'accepted'}};
          }else if(request.method==='tools/call')response={jsonrpc:'2.0',id:request.id,result:{success:true,contentItems:[]}};
        }
        const data=encodeFrame(response);socket.write(data.subarray(0,3));socket.write(data.subarray(3));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  const input=new DesktopInput({pipePath:pipe,timeoutMs:options.timeoutMs||500,wait:async()=>{}});
  return {input,pipe,requests,setOwnerReady:value=>{ownerReady=value;},close:async()=>{
    input.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
  }};
}

test('messages enter the existing desktop conversation as ordinary user input and inherit its provider and permissions',async()=>{
  const f=await fixture();try{
    await f.input.send({threadId:'target',prompt:'你好，检查 A < B & C'},()=>assert.fail('Already loaded chat was opened'));
    const sent=f.requests.find(r=>r.method==='thread-follower-start-turn');
    assert.equal(sent.version,2);assert.equal(sent.targetClientId,'desktop-owner');assert.equal(sent.params.conversationId,'target');
    const request=sent.params.turnStart.request;
    assert.equal(request.threadId,'target');assert.deepEqual(request.input,[{type:'text',text:'你好，检查 A < B & C',text_elements:[]}]);
    assert.match(request.clientUserMessageId,/^[0-9a-f-]{36}$/);
    assert.deepEqual(sent.params.turnStart.context,{inheritThreadSettings:true,useUserMessageAdmission:true});
    for(const key of ['toolOutput','callerSource','model','effort','approvalPolicy','sandboxPolicy','permissions','collaborationMode'])
      assert.equal(Object.hasOwn(request,key),false);
    assert.doesNotMatch(JSON.stringify(sent),/function_call_output|codex_delegation/);
  }finally{await f.close();}
});

test('an unloaded chat is opened once before a single send, with explicit phone model settings mapped correctly',async()=>{
  const f=await fixture({ownerReady:false});const opened=[];try{
    await f.input.send({threadId:'target',prompt:'任务',model:'custom-model',thinking:'high'},async id=>{
      opened.push(id);f.setOwnerReady(true);
    });
    assert.deepEqual(opened,['target']);assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
    const request=f.requests.at(-1).params.turnStart.request;assert.equal(request.model,'custom-model');assert.equal(request.effort,'high');
  }finally{await f.close();}
});

test('remote host routing keeps the host and uses its matching protocol version',async()=>{
  const f=await fixture();try{
    await f.input.send({threadId:'remote-chat',hostId:'ssh-host',prompt:'任务'},()=>{});
    assert.equal(f.requests[1].params.hostId,'ssh-host');
    assert.equal(f.requests.at(-1).hostId,'ssh-host');assert.equal(f.requests.at(-1).version,3);
  }finally{await f.close();}
});

test('missing ownership fails before sending and never falls back to delegated tool output',async()=>{
  const f=await fixture({ownerReady:false});let opened=0;try{
    await assert.rejects(f.input.send({threadId:'target',prompt:'任务'},async()=>{opened++;}),error=>error.notSent && /尚未发送/.test(error.message));
    assert.equal(opened,1);assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,0);
  }finally{await f.close();}
});

test('authorization is rechecked after loading and before the message is submitted',async()=>{
  const f=await fixture({ownerReady:false});let authorized=true;try{
    await assert.rejects(f.input.send({threadId:'target',prompt:'任务'},async()=>{
      f.setOwnerReady(true);authorized=false;
    },()=>{if(!authorized)throw new Error('revoked');}),error=>error.notSent && /授权已撤销/.test(error.message));
    assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,0);
  }finally{await f.close();}
});

test('an unconfirmed start is never retried and an explicit desktop failure is reported',async()=>{
  for(const options of [{dropStartAck:true,timeoutMs:80},{rejectStart:true}]){
    const f=await fixture(options);try{
      await assert.rejects(f.input.send({threadId:'target',prompt:'任务'},()=>{}),/未确认发送结果/);
      assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
    }finally{await f.close();}
  }
});

test('desktop client dispatches send through ordinary input while retaining the genuine app tools context',async()=>{
  const f=await fixture();const client=new DesktopClient({threadId:'genuine-caller',pipePath:'unused-app-tools',inputPipePath:f.pipe});
  try{
    const result=await client.call('send_message_to_thread',{threadId:'target',prompt:'你好'});
    assert.deepEqual(result,{threadId:'target',accepted:true});assert.ok(f.requests.every(r=>r.method!=='tools/call'));
    await assert.rejects(client.call('shell_exec',{}),/不支持/);
    const missing=new DesktopClient({inputPipePath:f.pipe});
    try{await assert.rejects(missing.call('send_message_to_thread',{threadId:'target',prompt:'任务'}),/缺少真实调用会话/);}finally{missing.close();}
  }finally{client.close();await f.close();}
});
