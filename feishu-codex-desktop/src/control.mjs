import net from 'node:net';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {dataDir,readJson,writeJson} from './storage.mjs';
import {equalSecret} from './router.mjs';

export async function createControl(onStop,onPreview) {
  const token=randomBytes(32).toString('hex');
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\codex-feishu-${token.slice(0,16)}`:path.join(dataDir,'control.sock');
  const server=net.createServer(socket=>{
    socket.setTimeout(5000,()=>socket.destroy());
    let data='';let handled=false;
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      if(handled) return;
      data+=chunk.toString();if(data.length>2048){socket.destroy();return;}
      if(!data.includes('\n')) return;
      let request;try{request=JSON.parse(data.split('\n')[0]);}catch{socket.destroy();return;}
      if(!equalSecret(request.token,token) || !['stop','preview'].includes(request.action)){socket.destroy();return;}
      if(request.action==='preview' && request.channel!==undefined && !['feishu','wechat'].includes(request.channel)){socket.destroy();return;}
      handled=true;
      if(request.action==='stop') {socket.end('ok\n');socket.once('close',()=>onStop());}
      else if(onPreview) Promise.resolve().then(()=>onPreview(request.channel||'feishu')).then(()=>socket.end('ok\n'),error=>socket.end(JSON.stringify({error:error.message})+'\n'));
      else socket.end('{"error":"Preview unavailable"}\n');
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  writeJson('control.json',{pipe,token});return server;
}
async function requestControl(action,channel) {
  const descriptor=readJson('control.json',{});
  if(!descriptor.pipe || !descriptor.token) throw new Error('没有可用桥接控制入口');
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection(descriptor.pipe);
    socket.setEncoding('utf8');let response='';
    socket.setTimeout(20000,()=>socket.destroy(new Error('桥接控制请求超时')));
    socket.once('error',reject);
    socket.once('connect',()=>socket.write(JSON.stringify({token:descriptor.token,action,...(channel?{channel}:{})})+'\n'));
    socket.on('data',chunk=>{
      response+=chunk;if(!response.includes('\n')) return;
      if(response.trim()==='ok'){socket.destroy();resolve();}
      else {let error;try{error=JSON.parse(response.trim()).error;}catch{}socket.destroy(new Error(error||'桥接控制失败'));}
    });
  });
}
export const stopControl=()=>requestControl('stop');
export const previewControl=(channel='feishu')=>requestControl('preview',channel);
