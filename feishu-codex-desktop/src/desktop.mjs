import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DesktopInput} from './desktop-input.mjs';

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
  constructor(context) { this.context = context; this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0);
    this.input=new DesktopInput({pipePath:context.inputPipePath}); }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    if (!this.context.pipePath) throw new Error('未收到桌面版连接信息，请在 Codex 内启动插件');
    this.connecting = new Promise((resolve,reject) => {
      const socket = net.createConnection(this.context.pipePath);
      const timer = setTimeout(() => socket.destroy(new Error('连接桌面版超时')),5000);
      socket.once('error',reject);
      socket.once('connect',() => {
        clearTimeout(timer); socket.off('error',reject); this.socket = socket;
        socket.on('data',chunk => this.onData(chunk));
        socket.on('error',error => this.disconnect(error));
        socket.on('close',() => this.disconnect(new Error('Codex 桌面连接已关闭，请重新启动桥接')));
        resolve();
      });
      socket.once('close',() => clearTimeout(timer));
    }).finally(() => {this.connecting = null;});
    return this.connecting;
  }
  async request(method,params,timeoutMs=30000) {
    await this.connect();
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
  close() {this.input.close();this.disconnect(new Error('桌面连接已关闭'));}
  async tools() {
    const result = await this.request('tools/list',{threadStartKind:'all'});
    return result.tools.filter(tool => tool.namespace === 'codex_app' && ALLOWED_TOOLS.has(tool.name));
  }
  async call(tool,args={},options={}) {
    if(!ALLOWED_TOOLS.has(tool)) throw new Error('不支持的桌面操作');
    if(!this.context.threadId) throw new Error('缺少真实调用会话，请从 Codex 桌面内启动桥接');
    if(tool==='send_message_to_thread')return this.input.send(args,options.beforeSend);
    const result=await this.request('tools/call',{
      namespace:'codex_app',tool,arguments:args,callerSource:'codex',
      threadId:this.context.threadId,hostId:'local',
      turnId:`feishu-${randomUUID()}`,callId:`feishu-${randomUUID()}`
    },tool==='wait_threads'?45000:30000);
    const output=(result.contentItems||[]).filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
    if(!result.success) throw new Error(output || '桌面操作失败');
    try {return JSON.parse(output);} catch {return {text:output};}
  }
}
