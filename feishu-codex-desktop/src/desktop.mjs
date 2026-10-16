import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DesktopInput} from './desktop-input.mjs';
import {recoverDesktopContext,desktopUnavailable} from './desktop-context.mjs';

const MAX_FRAME = 8 * 1024 * 1024;
// This is the desktop's installed app-tools transport. It is version-specific.
// Do not substitute a separate app-server: these must be the desktop's own chats.
export const ALLOWED_TOOLS = new Set([
  'list_threads','list_archived_threads','list_projects','read_thread','wait_threads',
  'send_message_to_thread','create_thread','set_thread_title','set_thread_archived',
  'fork_thread','move_thread_to_sidebar_section','navigate_to_codex_page'
]);
export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value),'utf8');
  if (body.length > MAX_FRAME) throw new Error('请求过大');
  const frame = Buffer.alloc(body.length+4);
  frame.writeUInt32LE(body.length); body.copy(frame,4); return frame;
}
export class DesktopClient {
  constructor(context,{recover=true,resolveContext=recoverDesktopContext}={}) { this.context = context; this.recover=recover;this.resolveContext=resolveContext;this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0);
    this.connectionGeneration=0;
    this.input=new DesktopInput({pipePath:context.inputPipePath,
      activateThread:({threadId})=>this.call('navigate_to_codex_page',{threadId})}); }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    if (!this.context.pipePath) throw new Error('未收到桌面版连接信息，请在 Codex 内启动插件');
    const generation=this.connectionGeneration;
    const connecting=this.openSocket(generation).catch(async error=>{
      if(!this.recover || !['ENOENT','ECONNREFUSED','EPIPE','ECONNRESET'].includes(error.code))throw error;
      if(generation!==this.connectionGeneration)throw desktopUnavailable();
      let next;
      try {
        next=await this.resolveContext(this.context,{probe:async context=>{
          const probe=new DesktopClient(context,{recover:false});
          try {
            const tools=await probe.tools({timeoutMs:1500});
            if(!tools.some(tool=>tool.name==='list_threads') || !tools.some(tool=>tool.name==='read_thread'))throw desktopUnavailable();
            await probe.probe({timeoutMs:3000});
          }finally{probe.close();}
        }});
      }catch{throw desktopUnavailable();}
      if(generation!==this.connectionGeneration)throw desktopUnavailable();
      this.context={...this.context,...next};
      try{await this.openSocket(generation);}catch{throw desktopUnavailable();}
    }).finally(()=>{if(this.connecting===connecting)this.connecting=null;});
    this.connecting=connecting;return connecting;
  }
  openSocket(generation) {
    return new Promise((resolve,reject) => {
      const socket = net.createConnection(this.context.pipePath);
      const timer = setTimeout(() => socket.destroy(new Error('连接桌面版超时')),5000);
      socket.once('error',reject);
      socket.once('connect',() => {
        if(generation!==this.connectionGeneration){socket.destroy();reject(new Error('桌面连接已更新'));return;}
        clearTimeout(timer); socket.off('error',reject); this.socket = socket;
        socket.on('data',chunk => this.onData(chunk));
        socket.on('error',error => {if(this.socket===socket)this.disconnect(error);});
        socket.on('close',() => {if(this.socket===socket)this.disconnect(new Error('Codex 桌面连接已关闭，正在等待重新连接'));});
        resolve();
      });
      socket.once('close',() => clearTimeout(timer));
    });
  }
  async request(method,params,timeoutMs=30000,beforeSend) {
    await this.connect();
    beforeSend?.();
    if(method==='tools/call' && params.namespace==='codex_app')params={...params,threadId:this.context.threadId};
    const id = this.nextId++;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === 'tools/call') this.socket?.write(encodeFrame({jsonrpc:'2.0',id,method:'tools/cancel'}));
        reject(new Error('桌面操作超时；操作结果未知，请检查会话后再决定是否重发'));
      },timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.socket.write(encodeFrame({jsonrpc:'2.0',id,method,params})); }
      catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if(size > MAX_FRAME) {this.close();return;}
      if(this.buffer.length < size+4) return;
      const raw = this.buffer.subarray(4,size+4); this.buffer = this.buffer.subarray(size+4);
      let value;
      try {value=JSON.parse(raw.toString('utf8'));}
      catch {this.close();return;}
      const pending = this.pending.get(value.id);
      if(!pending) continue;
      clearTimeout(pending.timer);this.pending.delete(value.id);
      if(value.error) pending.reject(new Error(value.error.message)); else pending.resolve(value.result);
    }
  }
  disconnect(error) {
    this.socket?.destroy();this.socket = null;this.buffer=Buffer.alloc(0);
    for(const item of this.pending.values()) {clearTimeout(item.timer);item.reject(error);}
    this.pending.clear();
  }
  close() {this.connectionGeneration++;this.connecting=null;this.input.close();this.disconnect(new Error('桌面连接已关闭'));}
  updateContext(context) {
    if(this.context.pipePath!==context.pipePath) {
      this.close();
    }
    this.context={...this.context,...context};
  }
  async tools({timeoutMs=30000}={}) {
    const result = await this.request('tools/list',{threadStartKind:'all'},timeoutMs);
    return (result.tools||[]).filter(tool => tool.namespace === 'codex_app' && ALLOWED_TOOLS.has(tool.name));
  }
  probe({timeoutMs=5000}={}) {
    return this.call('read_thread',{threadId:this.context.threadId,turnLimit:1,maxOutputCharsPerItem:1},{timeoutMs});
  }
  async call(tool,args={},options={}) {
    if(!ALLOWED_TOOLS.has(tool)) throw new Error('不支持的桌面操作');
    if(!this.context.threadId) throw new Error('缺少真实调用会话，请从 Codex 桌面内启动桥接');
    if(tool==='send_message_to_thread')return this.input.send(args,options.beforeSend,options);
    const result=await this.request('tools/call',{
      namespace:'codex_app',tool,arguments:args,callerSource:'codex',
      threadId:this.context.threadId,hostId:'local',
      turnId:`feishu-${randomUUID()}`,callId:`feishu-${randomUUID()}`
    },options.timeoutMs??(tool==='wait_threads'?45000:30000),options.beforeSend);
    const output=(result.contentItems||[]).filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
    if(!result.success) throw new Error(output || '桌面操作失败');
    try {return JSON.parse(output);} catch {return {text:output};}
  }
}
