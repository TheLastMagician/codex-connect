import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_FRAME=8*1024*1024;
const VERSIONS={initialize:0,'thread-owner-discovery':1,'thread-follower-start-turn':2};
export function desktopInputPath() {
  return process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':
    path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc','ipc.sock');
}
function frame(message) {
  const data=Buffer.from(JSON.stringify(message),'utf8');
  if(data.length>MAX_FRAME)throw new Error('消息过大');
  const header=Buffer.alloc(4);header.writeUInt32LE(data.length);return Buffer.concat([header,data]);
}
function inputError(message,notSent=false) {return Object.assign(new Error(message),{notSent});}

// Use the running desktop's coordination bus; never launch another Codex process.
export class DesktopInput {
  constructor({pipePath=desktopInputPath(),timeoutMs=10000}={}) {
    Object.assign(this,{pipePath,timeoutMs});this.pending=new Map();this.buffer=Buffer.alloc(0);
  }
  async connect() {
    if(this.socket && !this.socket.destroyed && this.clientId)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      this.clientId=null;this.buffer=Buffer.alloc(0);
      await new Promise((resolve,reject)=>{
        const socket=net.createConnection(this.pipePath);this.socket=socket;
        const timer=setTimeout(()=>socket.destroy(new Error('connect-timeout')),this.timeoutMs);
        socket.once('error',reject);socket.once('close',()=>clearTimeout(timer));
        socket.once('connect',()=>{
          clearTimeout(timer);socket.off('error',reject);
          socket.on('data',chunk=>this.onData(chunk));
          socket.on('error',()=>{if(this.socket===socket)this.disconnect();});
          socket.on('close',()=>{if(this.socket===socket)this.disconnect();});resolve();
        });
      });
      const response=await this.request('initialize',{clientType:'codex-connect'});
      if(response.resultType!=='success' || typeof response.result?.clientId!=='string')throw new Error('initialize-failed');
      this.clientId=response.result.clientId;
    })().catch(()=>{this.disconnect();throw inputError('桌面普通消息入口不可用，消息尚未发送。请保持 Codex 运行并重新启动桥接。',true);})
      .finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  request(method,params,{targetClientId,hostId,timeoutMs=this.timeoutMs}={}) {
    if(!Object.hasOwn(VERSIONS,method))throw inputError('不支持的桌面输入操作',true);
    if(!this.socket || this.socket.destroyed)throw inputError('桌面连接已关闭，消息尚未发送。',true);
    const requestId=randomUUID();const remote=hostId && hostId!=='local';
    const message={type:'request',requestId,sourceClientId:this.clientId||'initializing-client',
      version:VERSIONS[method]+(remote && method.startsWith('thread-follower-')?1:0),method,params,
      ...(targetClientId?{targetClientId}:{}),...(remote?{hostId}:{}),timeoutMs};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(requestId);reject(inputError('桌面未确认发送结果，请检查会话后再决定是否重发。'));
      },timeoutMs);
      this.pending.set(requestId,{resolve,reject,timer});
      try {this.socket.write(frame(message));}
      catch {clearTimeout(timer);this.pending.delete(requestId);reject(inputError('桌面连接中断，发送结果未知，请先检查会话。'));}
    });
  }
  onData(chunk) {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4) {
      const size=this.buffer.readUInt32LE(0);
      if(!size || size>MAX_FRAME){this.disconnect();return;}
      if(this.buffer.length<size+4)return;
      let message;try{message=JSON.parse(this.buffer.subarray(4,size+4).toString('utf8'));}
      catch{this.disconnect();return;}
      this.buffer=this.buffer.subarray(size+4);
      if(message.type==='client-discovery-request') {
        // The bridge is a client, not a conversation owner or approval handler.
        try{this.socket?.write(frame({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}}));}
        catch{this.disconnect();return;}
      }else if(message.type==='response') {
        const pending=this.pending.get(message.requestId);if(!pending)continue;
        clearTimeout(pending.timer);this.pending.delete(message.requestId);pending.resolve(message);
      }
    }
  }
  async findOwner(threadId,hostId='local') {
    const response=await this.request('thread-owner-discovery',{hostId,conversationId:threadId});
    if(response.resultType==='success' && typeof response.handledByClientId==='string')return response.handledByClientId;
    if(response.resultType==='error' && response.error==='no-client-found')return null;
    throw inputError('无法确认桌面会话连接，消息尚未发送。请重新启动桥接。',true);
  }
  async send({threadId,hostId='local',prompt,model,thinking},beforeSend) {
    if(typeof threadId!=='string' || !threadId.trim() || typeof prompt!=='string' || !prompt.trim() || prompt.length>12000)
      throw inputError('会话或消息无效，消息尚未发送。',true);
    const authorize=()=>{try{beforeSend?.();}catch{throw inputError('通道授权已撤销，消息尚未发送。',true);}};
    await this.connect();let owner;
    try {
      owner=await this.findOwner(threadId,hostId);
    }catch(error){if(error.notSent)throw error;throw inputError('无法确认目标桌面会话连接，消息尚未发送，也未切换桌面。请稍后重试。',true);}
    // Discovering an owner must never navigate or focus the desktop. The current
    // coordination protocol exposes no background resume for an unloaded chat.
    if(!owner)throw inputError('目标会话尚未加载，消息尚未发送，也未切换桌面。当前接口暂不支持后台加载此会话；可换一个已加载会话，或方便时在桌面手动打开目标后重试。',true);
    authorize();
    const request={threadId,clientUserMessageId:randomUUID(),input:[{type:'text',text:prompt,text_elements:[]}],
      ...(model?{model}:{}),...(thinking?{effort:thinking}:{})};
    // Let the desktop choose the input route for its actual host. Forcing
    // user-message admission selects a cloud-only extension on local/SSH hosts.
    const response=await this.request('thread-follower-start-turn',{conversationId:threadId,
      turnStart:{request,context:{inheritThreadSettings:true}}},{hostId,targetClientId:owner});
    if(response.resultType!=='success')throw inputError('桌面未确认发送结果，请在桌面检查该会话后再决定是否重发。');
    return {threadId,accepted:true};
  }
  disconnect() {
    const socket=this.socket;this.socket=null;this.clientId=null;this.buffer=Buffer.alloc(0);socket?.destroy();
    for(const pending of this.pending.values()) {
      clearTimeout(pending.timer);pending.reject(inputError('桌面连接中断，发送结果未知，请先检查会话。'));
    }
    this.pending.clear();
  }
  close(){this.disconnect();}
}
