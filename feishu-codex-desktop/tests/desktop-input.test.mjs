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
            options.onDiscovery?.();
            response=ownerReady?{...response,handledByClientId:'desktop-owner',result:{supportsUntrustedAppInput:true}}:
              {...response,resultType:'error',error:'no-client-found'};
          }else if(request.method==='thread-follower-start-turn') {
            if(options.dropStartAck)continue;
            // Local/SSH app-server hosts reject the cloud-only admission route.
            const cloudAdmission=request.params.turnStart.context?.useUserMessageAdmission===true;
            response=cloudAdmission?{...response,resultType:'error',error:'User-message admission requires a cloud app-server host'}:
              options.rejectStart?{...response,resultType:'error',error:options.rejectCode||'request-failed'}:{...response,result:{result:options.turnId?{turn:{id:options.turnId}}:'accepted'}};
          }else if(request.method==='tools/call')response={jsonrpc:'2.0',id:request.id,result:{success:true,contentItems:[]}};
        }
        const data=encodeFrame(response);socket.write(data.subarray(0,3));socket.write(data.subarray(3));
      }
    });
  });
  await new Promise(resolve=>server.listen(pipe,resolve));
  const input=new DesktopInput({pipePath:pipe,timeoutMs:options.timeoutMs||500,activateThread:options.activateThread,
    loadTimeoutMs:options.loadTimeoutMs??1000,pollIntervalMs:5});
  return {input,pipe,requests,setOwnerReady:(value=true)=>{ownerReady=value;},close:async()=>{
    input.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
  }};
}

test('local desktop starts an ordinary turn without forcing cloud user-message admission',async()=>{
  const f=await fixture();try{
    const result=await f.input.send({threadId:'local-target',prompt:'你好'});
    assert.deepEqual(result,{threadId:'local-target',accepted:true});
    assert.equal(Object.hasOwn(f.requests.at(-1).params.turnStart.context,'useUserMessageAdmission'),false);
  }finally{await f.close();}
});

test('messages enter the existing desktop conversation as ordinary user input and inherit its provider and permissions',async()=>{
  const f=await fixture();try{
    await f.input.send({threadId:'target',prompt:'你好，检查 A < B & C'});
    const sent=f.requests.find(r=>r.method==='thread-follower-start-turn');
    assert.equal(sent.version,2);assert.equal(sent.targetClientId,'desktop-owner');assert.equal(sent.params.conversationId,'target');
    const request=sent.params.turnStart.request;
    assert.equal(request.threadId,'target');assert.deepEqual(request.input,[{type:'text',text:'你好，检查 A < B & C',text_elements:[]}]);
    assert.match(request.clientUserMessageId,/^[0-9a-f-]{36}$/);
    assert.deepEqual(sent.params.turnStart.context,{inheritThreadSettings:true});
    for(const key of ['toolOutput','callerSource','model','effort','approvalPolicy','sandboxPolicy','permissions','collaborationMode'])
      assert.equal(Object.hasOwn(request,key),false);
    assert.doesNotMatch(JSON.stringify(sent),/function_call_output|codex_delegation/);
  }finally{await f.close();}
});

test('a loaded background chat receives a single message with explicit phone model settings',async()=>{
  const f=await fixture();try{
    await f.input.send({threadId:'background-chat',prompt:'任务',model:'custom-model',thinking:'high'});
    assert.deepEqual(f.requests.map(r=>r.method),['initialize','thread-owner-discovery','thread-follower-start-turn']);
    assert.equal(f.requests.at(-1).params.conversationId,'background-chat');
    const request=f.requests.at(-1).params.turnStart.request;assert.equal(request.model,'custom-model');assert.equal(request.effort,'high');
  }finally{await f.close();}
});

test('remote host routing keeps the host and uses its matching protocol version',async()=>{
  const f=await fixture();try{
    await f.input.send({threadId:'remote-chat',hostId:'ssh-host',prompt:'任务'});
    assert.equal(f.requests[1].params.hostId,'ssh-host');
    assert.equal(f.requests.at(-1).hostId,'ssh-host');assert.equal(f.requests.at(-1).version,3);
    assert.deepEqual(f.requests.at(-1).params.turnStart.context,{inheritThreadSettings:true});
  }finally{await f.close();}
});

test('an unloaded chat without an activation callback fails before sending',async()=>{
  const f=await fixture({ownerReady:false});try{
    await assert.rejects(f.input.send({threadId:'target',prompt:'任务'}),error=>
      error.notSent && /尚未发送/.test(error.message) && /重新启动桥接/.test(error.message));
    assert.deepEqual(f.requests.map(r=>r.method),['initialize','thread-owner-discovery']);
  }finally{await f.close();}
});

test('a cold chat opens once and waits for its actual host owner before sending the original text',async()=>{
  const opened=[];let discoveries=0;
  const prompt='请检查这个会话，保留原来的模型和项目，中文逗号、句号。以及“引号”与换行\n都应原样发送。';
  const f=await fixture({ownerReady:false,activateThread:async args=>{opened.push(args);},
    onDiscovery:()=>{if(++discoveries===4)f.setOwnerReady();}});
  try {
    const result=await f.input.send({threadId:'cold-chat',hostId:'ssh-host',prompt,model:'custom-model',thinking:'xhigh'});
    assert.deepEqual(result,{threadId:'cold-chat',accepted:true});
    assert.deepEqual(opened,[{threadId:'cold-chat',hostId:'ssh-host'}]);
    assert.equal(discoveries,4);
    const starts=f.requests.filter(r=>r.method==='thread-follower-start-turn');assert.equal(starts.length,1);
    assert.equal(starts[0],f.requests.at(-1));assert.equal(starts[0].hostId,'ssh-host');
    assert.equal(starts[0].params.turnStart.request.input[0].text,prompt);
    assert.equal(starts[0].params.turnStart.request.model,'custom-model');
    assert.equal(starts[0].params.turnStart.request.effort,'xhigh');
    assert.deepEqual(starts[0].params.turnStart.context,{inheritThreadSettings:true});
  }finally{await f.close();}
});

test('an already loaded chat never activates the desktop',async()=>{
  const f=await fixture({activateThread:()=>assert.fail('Loaded chats must stay in the background')});
  try{await f.input.send({threadId:'loaded-chat',prompt:'你好，世界。'});}
  finally{await f.close();}
});

test('navigation failure or a loading timeout never submits a message or retries navigation',async()=>{
  for(const failNavigation of [true,false]) {
    let opens=0;
    const f=await fixture({ownerReady:false,loadTimeoutMs:25,activateThread:async()=>{
      opens++;if(failNavigation)throw new Error('Navigation unavailable');
    }});
    try {
      await assert.rejects(f.input.send({threadId:'cold-chat',prompt:'任务'}),error=>
        error.notSent && /消息尚未发送/.test(error.message) && !/未切换桌面/.test(error.message));
      assert.equal(opens,1);assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,0);
    }finally{await f.close();}
  }
});

test('revoking authorization before opening or while loading prevents message submission',async()=>{
  for(const revokeDuringLoad of [false,true]) {
    let authorized=true,opens=0;
    const f=await fixture({ownerReady:false,activateThread:async()=>{opens++;authorized=false;},
      onDiscovery:()=>{if(!revokeDuringLoad)authorized=false;}});
    try {
      await assert.rejects(f.input.send({threadId:'cold-chat',prompt:'任务'},()=>{
        if(!authorized)throw new Error('revoked');
      }),error=>error.notSent && /授权已撤销/.test(error.message));
      assert.equal(opens,revokeDuringLoad?1:0);
      assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,0);
    }finally{await f.close();}
  }
});

test('concurrent sends to the same cold chat share its opening and each send once',async()=>{
  let opens=0,discoveries=0;
  const f=await fixture({ownerReady:false,activateThread:async()=>{opens++;},
    onDiscovery:()=>{if(++discoveries===5)f.setOwnerReady();}});
  try {
    await Promise.all(['第一条，消息。','第二条，消息。'].map(prompt=>f.input.send({threadId:'cold-chat',prompt})));
    assert.equal(opens,1);
    const starts=f.requests.filter(r=>r.method==='thread-follower-start-turn');assert.equal(starts.length,2);
    assert.deepEqual(starts.map(r=>r.params.turnStart.request.input[0].text).sort(),['第一条，消息。','第二条，消息。'].sort());
  }finally{await f.close();}
});

test('authorization revoked during owner discovery prevents message submission',async()=>{
  let authorized=true;
  const f=await fixture({onDiscovery:()=>{authorized=false;}});try{
    await assert.rejects(f.input.send({threadId:'target',prompt:'任务'},()=>{
      if(!authorized)throw new Error('revoked');
    }),error=>error.notSent && /授权已撤销/.test(error.message));
    assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,0);
  }finally{await f.close();}
});

test('an unconfirmed start is never retried and an explicit desktop failure is reported',async()=>{
  for(const options of [{dropStartAck:true,timeoutMs:80},{rejectStart:true}]){
    const f=await fixture(options);try{
      await assert.rejects(f.input.send({threadId:'target',prompt:'任务'}),/未确认发送结果/);
      assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
    }finally{await f.close();}
  }
});

test('desktop client opens a cold target using genuine app context, then sends ordinary input exactly once',async()=>{
  const f=await fixture({ownerReady:false});const client=new DesktopClient({threadId:'genuine-caller',inputPipePath:f.pipe});
  const appCalls=[];client.request=async(method,args)=>{
    appCalls.push({method,args});f.setOwnerReady();return {success:true,contentItems:[]};
  };
  try{
    await client.call('send_message_to_thread',{threadId:'unloaded-target',prompt:'你好，检查一下。'});
    assert.equal(appCalls.length,1);assert.equal(appCalls[0].method,'tools/call');
    assert.equal(appCalls[0].args.threadId,'genuine-caller');assert.equal(appCalls[0].args.callerSource,'codex');
    assert.equal(appCalls[0].args.tool,'navigate_to_codex_page');
    assert.deepEqual(appCalls[0].args.arguments,{threadId:'unloaded-target'});
    assert.deepEqual(f.requests.map(r=>r.method),['initialize','thread-owner-discovery','thread-owner-discovery','thread-follower-start-turn']);
    assert.equal(f.requests.at(-1).params.turnStart.request.input[0].text,'你好，检查一下。');
  }finally{client.close();await f.close();}
});

test('an explicit request to open a chat still uses the navigation tool',async()=>{
  const client=new DesktopClient({threadId:'genuine-caller'});const appCalls=[];
  client.request=async(method,args)=>{appCalls.push({method,args});return {success:true,contentItems:[]};};
  try{
    await client.call('navigate_to_codex_page',{threadId:'chosen-target'});
    assert.equal(appCalls.length,1);assert.equal(appCalls[0].args.tool,'navigate_to_codex_page');
    assert.deepEqual(appCalls[0].args.arguments,{threadId:'chosen-target'});
  }finally{client.close();}
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

test('fixed-queue correlation IDs survive native submission and return the actual acknowledged turn ID',async()=>{
  const f=await fixture({turnId:'real-turn'});try {
    const id=randomUUID();const result=await f.input.send({threadId:'target',prompt:'原文',clientUserMessageId:id});
    assert.equal(f.requests.at(-1).params.turnStart.request.clientUserMessageId,id);assert.equal(result.clientUserMessageId,id);assert.equal(result.turnId,'real-turn');
    await assert.rejects(f.input.send({threadId:'target',prompt:'原文',clientUserMessageId:'bad-id'}),e=>e.notSent);
    assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
  }finally{await f.close();}
});

test('a router rejection before reaching a desktop owner is definitely unsent, while a native failure remains unknown',async()=>{
  for(const code of ['no-client-found','version-mismatch','request-failed']) {
    const f=await fixture({rejectStart:true,rejectCode:code});try {
      await assert.rejects(f.input.send({threadId:'target',prompt:'原文'}),e=>e.notSent===(code!=='request-failed'));
      assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
    }finally{await f.close();}
  }
});
