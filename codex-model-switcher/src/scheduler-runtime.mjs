import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {scheduleDirectory,SCHEDULER_VERSION} from './schedules.mjs';

export const schedulerPipe=()=>process.platform==='win32'?'\\\\.\\pipe\\codex-model-switcher-scheduler-'+createHash('sha256').update(path.resolve(scheduleDirectory()).toLowerCase()).digest('hex').slice(0,16):path.join(scheduleDirectory(),'worker.sock');
export function schedulerControl(command='health',token){
  return new Promise(resolve=>{
    const socket=net.createConnection(schedulerPipe());let data='';
    const done=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(1500,()=>done(null));socket.on('error',()=>done(null));
    socket.on('connect',()=>socket.write(JSON.stringify({command,token})+'\n'));
    socket.on('data',chunk=>{data+=chunk;if(data.length>8192)return done(null);if(data.includes('\n')){try{done(JSON.parse(data));}catch{done(null);}}});
    socket.on('end',()=>done(null));
  });
}
export class SchedulerRuntime {
  constructor(bundle){this.bundle=bundle;}
  async status(){return await schedulerControl()||{running:false,version:null};}
  async ensure(){
    if(this.starting)return this.starting;
    this.starting=this.start().finally(()=>{this.starting=null;});return this.starting;
  }
  async stop(){
    if(process.platform==='win32')await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$taskRunKey='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if(Test-Path $taskRunKey){$taskRunValues=Get-ItemProperty -Path $taskRunKey -ErrorAction Stop; if($null -ne $taskRunValues.PSObject.Properties['CodexModelScheduler']){Remove-ItemProperty -Path $taskRunKey -Name 'CodexModelScheduler' -ErrorAction Stop}}"],{windowsHide:true});
    const tokenFile=path.join(scheduleDirectory(),'control.key');
    if(fs.existsSync(tokenFile))await schedulerControl('stop',fs.readFileSync(tokenFile,'utf8'));
    for(let i=0;i<20&&await schedulerControl();i++)await delay(250);
    return await this.status();
  }
  async start(){
    if(process.platform!=='win32')throw new Error('独立定时服务目前只验证并支持 Windows。');
    const folder=path.join(scheduleDirectory(),'runtime');fs.mkdirSync(folder,{recursive:true,mode:0o700});
    const tokenFile=path.join(scheduleDirectory(),'control.key');
    if(!fs.existsSync(tokenFile))try{fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    const health=await schedulerControl();
    if(health?.version&&health.version!==SCHEDULER_VERSION){
      await schedulerControl('stop',fs.readFileSync(tokenFile,'utf8'));
      for(let i=0;i<20&&await schedulerControl();i++)await delay(250);
      if(await schedulerControl())throw new Error('旧版定时服务仍在退出，请稍后重试。');
    }
    const target=path.join(folder,'scheduler.cjs');
    if(!this.bundle||!fs.existsSync(this.bundle))throw new Error('定时服务构建文件不存在，请更新插件。');
    const data=fs.readFileSync(this.bundle),tmp=target+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,data,{mode:0o600});fs.renameSync(tmp,target);
    const quoted=value=>'"'+value.replaceAll('"','""')+'"';
    const command=`"${process.execPath}" "${target}"`;
    const vbs=path.join(folder,'start.vbs');
    const codexHome=path.dirname(path.dirname(scheduleDirectory()));
    fs.writeFileSync(vbs,Buffer.from(`\uFEFFSet taskShell = CreateObject("WScript.Shell")\r\nSet taskEnv = taskShell.Environment("PROCESS")\r\ntaskEnv("CODEX_HOME") = ${quoted(codexHome)}\r\ntaskShell.Run ${quoted(command)}, 0, False\r\n`,'utf16le'),{mode:0o600});
    const wscript=path.join(process.env.WINDIR||'C:\\Windows','System32','wscript.exe');
    if(!fs.existsSync(wscript))throw new Error('系统缺少 Windows Script Host，无法配置隐藏启动。');
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Force | Out-Null; New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'CodexModelScheduler' -PropertyType String -Value $env:CODEX_SCHEDULER_STARTUP_COMMAND -Force | Out-Null"],{windowsHide:true,env:{...process.env,CODEX_SCHEDULER_STARTUP_COMMAND:`"${wscript}" "${vbs}"`}});
    if(!(await schedulerControl())){
      const child=spawn(process.execPath,[target],{detached:true,windowsHide:true,stdio:'ignore',env:process.env});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    }
    for(let i=0;i<30;i++){const result=await schedulerControl();if(result?.version===SCHEDULER_VERSION)return result;await delay(200);}
    throw new Error('定时服务尚未启动，请检查本机 Node.js。任务已保存，可稍后重新启用。');
  }
}
