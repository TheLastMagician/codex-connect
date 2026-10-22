import fs from 'node:fs';
import path from 'node:path';
import {DesktopClient} from './desktop.mjs';
import {dataDir,secureDirectory,readJson,writeJson} from './storage.mjs';
import {createControl} from './control.mjs';
import {ChannelManager} from './channel-manager.mjs';
import {createDashboard} from './dashboard.mjs';
import {VERSION} from './version.mjs';
import {removeLegacyAssistantData} from './legacy-cleanup.mjs';
import {rememberDesktopContext} from './desktop-context-store.mjs';

export async function main() {
  secureDirectory();
  const lockPath=path.join(dataDir,'bridge.lock');
  try {
    const lock=fs.openSync(lockPath,'wx',0o600);
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:Date.now()}));fs.closeSync(lock);
  }catch(error) {
    if(error.code!=='EEXIST')throw error;
    const old=readJson('bridge.lock',{});
    if(old.pid) {try{process.kill(old.pid,0);throw new Error('桌面聊天桥接已在运行');}catch(probe){if(probe.code!=='ESRCH')throw probe;}}
    fs.unlinkSync(lockPath);return main();
  }
  let manager;let dashboard;let desktop;let control;let timer;let polling=false;let stopping=false;
  const status={pid:process.pid,version:VERSION,state:'starting',startedAt:Date.now(),desktopConnected:false,channels:{}};
  const saveStatus=()=>writeJson('status.json',status);
  const channelStatus=(id,update)=>{
    status.channels[id]={...status.channels[id],...update};
    if(id==='feishu' || id==='wechat')status[id+'State']=status.channels[id].state;
    if(id==='feishu' && update.lastCardActionAt)status.lastCardActionAt=update.lastCardActionAt;
    saveStatus();
  };
  const stop=async()=>{
    if(stopping)return;stopping=true;clearInterval(timer);
    await manager?.stop();await dashboard?.close();
    desktop?.close();control?.close();status.state='stopped';status.desktopConnected=false;saveStatus();
    try{fs.unlinkSync(lockPath);}catch{}process.exit(0);
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const refreshDesktop=async()=>{
    let current=readJson('desktop-context.json',{});
    if(!current.pipePath || !current.threadId)return;
    try {
      if(current.pipePath!==desktop.context.pipePath || current.threadId!==desktop.context.threadId) {
        const probe=new DesktopClient(current);
        try{await probe.probe();current={...probe.context};}finally{probe.close();}
        desktop.updateContext(current);
      }
      await desktop.probe();
      rememberDesktopContext(desktop.context);
      if(desktop.lastRecovery)status.desktopRecovery=desktop.lastRecovery;
      if(!desktop.input.socket || desktop.input.socket.destroyed)await desktop.input.connect();
      status.desktopConnected=true;
    }catch{status.desktopConnected=false;}
    saveStatus();
  };
  try {
    removeLegacyAssistantData(dataDir,writeJson);
    control=await createControl(stop,async(id='feishu')=>{
      const channel=manager?.channels.get(id);if(!channel)throw new Error('这个通道尚未连接。');
      await channel.preview();
    });
    desktop=new DesktopClient(readJson('desktop-context.json',{}));
    manager=new ChannelManager({desktop,onStatus:channelStatus,isPaused:()=>{
      const context=readJson('desktop-context.json',{});return !!context.pipePath && readJson('autostart-pause.json',{}).pipePath===context.pipePath;
    }});
    dashboard=await createDashboard({desktop,getStatus:()=>status,onChange:()=>manager.reconcile()});
    status.dashboard={baseUrl:dashboard.baseUrl,port:dashboard.port};saveStatus();
    // Keep chat channels alive while the desktop is restarting, so background
    // discovery can reconnect without a new local chat or manual bridge start.
    await refreshDesktop();status.messageTransport='desktop-user-input';saveStatus();
    await manager.reconcile();
    status.state='running';saveStatus();
    timer=setInterval(async()=>{
      if(polling || stopping)return;polling=true;
      try {
        await refreshDesktop();
        await manager.reconcile();
        await manager.poll();
      }catch{status.lastRefreshErrorAt=Date.now();saveStatus();}
      finally{polling=false;}
    },5000);
  }catch(error) {
    status.state='failed';status.error=error.message;status.desktopConnected=false;saveStatus();
    await manager?.stop();await dashboard?.close();
    desktop?.close();control?.close();try{fs.unlinkSync(lockPath);}catch{}
    console.error('桌面桥接启动失败；请用插件状态工具查看诊断。');process.exitCode=1;
  }
}
main().catch(()=>{console.error('桌面桥接发生错误。');process.exitCode=1;});
