import net from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const VERSIONS={initialize:0,'thread-owner-discovery':1,'thread-follower-read-model-settings':1,'thread-follower-update-thread-settings':2};
export class DesktopReader {
  constructor({pipePath=process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc','ipc.sock'),timeoutMs=8000}={}) {Object.assign(this,{pipePath,timeoutMs});this.buffer=Buffer.alloc(0);this.pending=new Map();}
  async connect() {
    await new Promise((resolve,reject)=>{
      this.socket=net.createConnection(this.pipePath);
      const timer=setTimeout(()=>this.socket.destroy(new Error('桌面连接超时。')),this.timeoutMs);
      this.socket.once('connect',()=>{clearTimeout(timer);resolve();});this.socket.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    this.socket.on('data',chunk=>this.onData(chunk));
    this.socket.on('error',()=>this.close());this.socket.on('close',()=>this.close());
    const reply=await this.request('initialize',{clientType:'codex-model-switcher'});
    if(reply.resultType!=='success')throw new Error('桌面连接初始化失败。');
    this.clientId=reply.result.clientId;
  }
  request(method,params,{targetClientId}={}) {
    if(!Object.hasOwn(VERSIONS,method))throw new Error('不支持的桌面只读操作。');
    const requestId=randomUUID();
    const data=Buffer.from(JSON.stringify({type:'request',requestId,sourceClientId:this.clientId||'initializing-client',
      version:VERSIONS[method],method,params,timeoutMs:this.timeoutMs,...(targetClientId?{targetClientId}:{})}));
    const header=Buffer.alloc(4);header.writeUInt32LE(data.length);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('桌面读取超时。'));},this.timeoutMs);
      this.pending.set(requestId,{resolve,reject,timer});this.socket.write(Buffer.concat([header,data]));
    });
  }
  onData(chunk) {
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4) {
      const size=this.buffer.readUInt32LE(0);if(size>8*1024*1024||size===0){this.close();return;}
      if(this.buffer.length<size+4)return;
      let msg;try{msg=JSON.parse(this.buffer.subarray(4,size+4));}catch{this.close();return;}
      this.buffer=this.buffer.subarray(size+4);
      if(msg.type==='client-discovery-request') {
        const reply=Buffer.from(JSON.stringify({type:'client-discovery-response',requestId:msg.requestId,response:{canHandle:false}}));
        const h=Buffer.alloc(4);h.writeUInt32LE(reply.length);this.socket.write(Buffer.concat([h,reply]));
      }
      const item=this.pending.get(msg.requestId);
      if(msg.type==='response'&&item){clearTimeout(item.timer);this.pending.delete(msg.requestId);item.resolve(msg);}
    }
  }
  async settings(threadId) {
    const owner=await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId});
    if(owner.resultType!=='success'||!owner.handledByClientId)return null;
    const reply=await this.request('thread-follower-read-model-settings',{conversationId:threadId},{targetClientId:owner.handledByClientId});
    if(reply.resultType!=='success')throw new Error('桌面无法读取该会话的模型设置。');
    return reply.result.settings;
  }
  async setModel(threadId,providerId,model,effort='none',{verifiedStoredProvider,settleMs=10000,pollMs=120,now=Date.now,sleep=delay}={}) {
    const before=await this.settings(threadId);
    if(!before)throw new Error('新会话尚未在桌面加载。');
    const pendingProvider=(before.modelProvider==null||before.modelProvider==='')&&verifiedStoredProvider===providerId&&before.resumeState==='resumed';
    if(before.modelProvider!==providerId&&!pendingProvider)throw new Error('桌面实际供应商与选择不一致，模型未修改。');
    const matches=settings=>settings?.model===model&&settings.modelProvider===providerId&&settings.reasoningEffort===effort;
    if(matches(before))return before;
    const owner=await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId});
    if(owner.resultType!=='success')throw new Error('桌面会话连接已变化，请重新打开该会话。');
    const reply=await this.request('thread-follower-update-thread-settings',{
      conversationId:threadId,threadSettings:{model,effort,serviceTier:null},
      condition:{ifModelEquals:before.model,ifEffortEquals:before.reasoningEffort??null}
    },{targetClientId:owner.handledByClientId});
    if(reply.resultType!=='success'||!reply.result?.applied)throw new Error('模型设置未被桌面确认，请刷新后重试。');
    const deadline=now()+settleMs;
    do {
      const after=await this.settings(threadId);
      if(matches(after))return after;
      if(after?.modelProvider&&after.modelProvider!==providerId)throw new Error('桌面返回了其他供应商，尚未确认所选模型。');
      if(now()>=deadline)break;
      await sleep(pollMs);
    }while(true);
    throw new Error('桌面的模型设置通知尚未完成，请点击“打开并确认模型”重试，不会重复创建。');
  }
  close() {
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('桌面读取连接已关闭。'));}
    this.pending.clear();this.socket?.destroy();
  }
}
