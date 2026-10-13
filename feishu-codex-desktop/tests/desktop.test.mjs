import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopClient,encodeFrame} from '../src/desktop.mjs';
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
