import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export function codexBinary(env=process.env) {
  if(env.CODEX_SWITCHER_CODEX_PATH) return env.CODEX_SWITCHER_CODEX_PATH;
  if(process.platform==='win32') {
    const root=path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
    try {
      const candidates=fs.readdirSync(root).map(name=>path.join(root,name,'codex.exe'))
        .filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
      if(candidates.length) return candidates[0];
    } catch {}
  }
  for(const file of ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex'])
    if(fs.existsSync(file)) return file;
  return 'codex';
}

// A short-lived official app-server client. Never edits config.toml or auth.json.
export class AppServer {
  constructor({binary=codexBinary(),env=process.env,timeoutMs=45000,overrides={}}={}) {
    Object.assign(this,{binary,env,timeoutMs,overrides});this.pending=new Map();this.nextId=1;
  }
  async connect() {
    const args=['app-server','--listen','stdio://'];
    for(const [key,value] of Object.entries(this.overrides))args.push('-c',`${key}=${JSON.stringify(value)}`);
    this.child=spawn(this.binary,args,{
      env:this.env,windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child.on('error',()=>this.fail('无法启动本机 Codex。请检查 Codex 桌面版是否已安装。'));
    this.child.on('exit',()=>this.fail('Codex 连接已关闭，请刷新后重试。'));
    this.child.stdin.on('error',()=>{});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      const item=this.pending.get(message.id);if(!item)return;
      clearTimeout(item.timer);this.pending.delete(message.id);
      if(message.error)item.reject(new Error(`Codex 拒绝了 ${item.method} 请求（${message.error.code}）。`));
      else item.resolve(message.result);
    });
    await this.request('initialize',{clientInfo:{name:'codex_model_switcher',title:'供应商与模型',version:'0.3.1'},capabilities:{experimentalApi:true}});
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
    return this;
  }
  request(method,params={}) {
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。新建结果可能未知，请先刷新会话列表，不要连续重试。`));
      },this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  fail(message) {
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error(message));}
    this.pending.clear();
  }
  async close() {
    this.fail('连接已结束');this.lines?.close();
    if(!this.child||this.child.exitCode!==null)return;
    await new Promise(resolve=>{
      const timer=setTimeout(()=>{this.child.kill();resolve();},2500);
      this.child.once('exit',()=>{clearTimeout(timer);resolve();});this.child.stdin.end();
    });
  }
}

export async function withAppServer(action,options) {
  const client=new AppServer(options);
  try {await client.connect();return await action(client);}finally{await client.close();}
}
