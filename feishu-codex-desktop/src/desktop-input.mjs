import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

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
  constructor({pipePath=desktopInputPath(),timeoutMs=10000,activateThread,loadTimeoutMs=120000,pollIntervalMs=300}={}) {
    Object.assign(this,{pipePath,timeoutMs,activateThread,loadTimeoutMs,pollIntervalMs});
    this.pending=new Map();this.buffer=Buffer.alloc(0);this.loading=new Map();
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
        this.pending.delete(requestId);reject(Object.assign(inputError('桌面未确认发送结果，请检查会话后再决定是否重发。'),{nativeReason:'request_timeout'}));
      },timeoutMs);
      this.pending.set(requestId,{resolve,reject,timer});
      try {this.socket.write(frame(message));}
      catch {clearTimeout(timer);this.pending.delete(requestId);reject(Object.assign(inputError('桌面连接中断，发送结果未知，请先检查会话。'),{nativeReason:'connection_closed'}));}
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
  async findOwner(threadId,hostId='local',timeoutMs=this.timeoutMs) {
    const response=await this.request('thread-owner-discovery',{hostId,conversationId:threadId},{timeoutMs});
    if(response.resultType==='success' && typeof response.handledByClientId==='string')return response.handledByClientId;
    if(response.resultType==='error' && response.error==='no-client-found')return null;
    throw inputError('无法确认桌面会话连接，消息尚未发送。请重新启动桥接。',true);
  }
  async discoverOwner(threadId,hostId,authorize) {
    for(let attempt=0;attempt<2;attempt++) {
      authorize();
      try {await this.connect();return await this.findOwner(threadId,hostId);}
      catch {
        authorize();
        if(attempt)throw inputError('已保留所选会话，但桌面消息连接暂不可用，这条消息尚未发送。稍后可直接重发，无需重新选择。',true);
        // Owner discovery is read-only. A stale idle socket may reconnect on
        // its next request; do not replay thread-follower-start-turn here.
        await delay(150);
      }
    }
  }
  async loadOwner(threadId,hostId,authorize,beforeActivate) {
    if(!this.activateThread)throw inputError('目标会话尚未加载，消息尚未发送。请重新启动桥接以启用自动打开会话。',true);
    const key=JSON.stringify([hostId,threadId]);
    let loading=this.loading.get(key);
    if(!loading) {
      loading=(async()=>{
        authorize();
        // A queued request may retry discovery without repeatedly focusing the
        // desktop. Its router persists this decision before the first opening.
        let activate;
        try {activate=beforeActivate?.();}catch{throw inputError('无法确认通道状态，消息尚未发送。',true);}
        if(activate===false)throw inputError('目标会话连接尚未恢复，消息已保留；不会再次自动切换桌面。',true);
        try {await this.activateThread({threadId,hostId});}
        catch {throw inputError('未能确认目标会话已打开，消息尚未发送。请检查桌面连接后重试。',true);}
        const deadline=Date.now()+this.loadTimeoutMs;
        while(Date.now()<deadline) {
          authorize();
          let owner;
          try {owner=await this.findOwner(threadId,hostId,Math.min(this.timeoutMs,Math.max(1,deadline-Date.now())));}
          catch {throw inputError('已尝试打开目标会话，但无法确认加载状态，消息尚未发送。请检查桌面连接后重试。',true);}
          if(owner)return owner;
          await delay(Math.min(this.pollIntervalMs,Math.max(1,deadline-Date.now())));
        }
        throw inputError('目标会话加载超时，本条消息尚未发送。请检查桌面该会话是否有加载错误，再重新发送。',true);
      })();
      this.loading.set(key,loading);
    }
    try {return await loading;}
    finally {if(this.loading.get(key)===loading)this.loading.delete(key);}
  }
  async send({threadId,hostId='local',prompt,model,thinking,clientUserMessageId},beforeSend,{beforeSubmit,beforeActivate}={}) {
    if(typeof threadId!=='string' || !threadId.trim() || typeof prompt!=='string' || !prompt.trim() || prompt.length>12000)
      throw inputError('会话或消息无效，消息尚未发送。',true);
    if(clientUserMessageId!==undefined && (typeof clientUserMessageId!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientUserMessageId)))
      throw inputError('消息标识无效，消息尚未发送。',true);
    const authorize=()=>{try{beforeSend?.();}catch{throw inputError('通道授权已撤销，消息尚未发送。',true);}};
    authorize();
    let owner=await this.discoverOwner(threadId,hostId,authorize);
    // Loaded chats stay in the background. For cold chats the user permits
    // opening the target; navigation alone is not proof that it has loaded.
    authorize();
    if(!owner)owner=await this.loadOwner(threadId,hostId,authorize,beforeActivate);
    // Loading can take seconds. Recheck queue readiness after it completes,
    // before any native write, so a newly started desktop task is not steered.
    try {await beforeSubmit?.();}
    catch(error) {throw Object.assign(inputError(error.message||'发送前检查失败，消息尚未发送。',true),{code:error.code});}
    authorize();
    const request={threadId,clientUserMessageId:clientUserMessageId||randomUUID(),input:[{type:'text',text:prompt,text_elements:[]}],
      ...(model?{model}:{}),...(thinking?{effort:thinking}:{})};
    // Let the desktop choose the input route for its actual host. Forcing
    // user-message admission selects a cloud-only extension on local/SSH hosts.
    const response=await this.request('thread-follower-start-turn',{conversationId:threadId,
      turnStart:{request,context:{inheritThreadSettings:true}}},{hostId,targetClientId:owner});
    if(response.resultType!=='success') {
      if(['no-client-found','version-mismatch','unsupported-version'].includes(response.error))throw Object.assign(inputError('目标桌面连接已失效，消息尚未发送。',true),{nativeReason:'router_rejected'});
      const reason=typeof response.error==='string' && response.error.includes('thread-follower-start-turn-timeout')?'start_timeout':'native_error';
      throw Object.assign(inputError('桌面未确认发送结果，请在桌面检查该会话后再决定是否重发。'),{nativeReason:reason});
    }
    const turnId=response.result?.result?.turn?.id;
    return {threadId,accepted:true,...(clientUserMessageId?{clientUserMessageId}:{}),...(typeof turnId==='string'?{turnId}:{})};
  }
  disconnect() {
    const socket=this.socket;this.socket=null;this.clientId=null;this.buffer=Buffer.alloc(0);socket?.destroy();
    for(const pending of this.pending.values()) {
      clearTimeout(pending.timer);pending.reject(Object.assign(inputError('桌面连接中断，发送结果未知，请先检查会话。'),{nativeReason:'connection_closed'}));
    }
    this.pending.clear();
  }
  close(){this.disconnect();}
}
