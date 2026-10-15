import fs from 'node:fs';
import path from 'node:path';
import {DesktopClient} from './desktop.mjs';
import {dataDir,secureDirectory,config,readJson,writeJson} from './storage.mjs';
import {createControl} from './control.mjs';
import {createFeishuChannel} from './channels/feishu.mjs';
import {createWechatChannel} from './channels/wechat.mjs';
import {VERSION} from './version.mjs';
import {readWechatAccount} from './wechat-storage.mjs';
import {prepareNewThreadCompat} from './responses-compat-settings.mjs';

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
  const channels=new Map();let desktop;let control;let timer;let polling=false;let stopping=false;let wechatIdentity;
  const status={pid:process.pid,version:VERSION,state:'starting',startedAt:Date.now(),desktopConnected:false,channels:{}};
  const saveStatus=()=>writeJson('status.json',status);
  const channelStatus=(id,update)=>{
    status.channels[id]={...status.channels[id],...update};
    status[id+'State']=status.channels[id].state;
    if(id==='feishu' && update.lastCardActionAt)status.lastCardActionAt=update.lastCardActionAt;
    saveStatus();
  };
  const stop=async()=>{
    if(stopping)return;stopping=true;clearInterval(timer);
    await Promise.allSettled([...channels.values()].map(c=>c.stop()));
    desktop?.close();control?.close();status.state='stopped';status.desktopConnected=false;saveStatus();
    try{fs.unlinkSync(lockPath);}catch{}process.exit(0);
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const refreshDesktop=async()=>{
    const current=readJson('desktop-context.json',{});
    if(!current.pipePath || !current.threadId)return;
    try {
      if(current.pipePath!==desktop.context.pipePath || current.threadId!==desktop.context.threadId) {
        const probe=new DesktopClient(current);
        try{await probe.call('list_threads',{limit:1});}finally{probe.close();}
        desktop.updateContext(current);
      }
      if(!desktop.socket || desktop.socket.destroyed)await desktop.call('list_threads',{limit:1});
      if(!desktop.input.socket || desktop.input.socket.destroyed)await desktop.input.connect();
      status.desktopConnected=true;
    }catch{status.desktopConnected=false;}
    saveStatus();
  };
  const refreshWechat=async()=>{
    const account=readWechatAccount();
    const valid=account.enabled && account.token && account.botId && account.ownerUserId;
    const identity=valid?JSON.stringify([account.botId,account.ownerUserId,account.token]):'';
    const login=readJson('wechat-login.json',{});
    const pending=['wait','scaned','need_verifycode'].includes(login.status) && login.expiresAt>Date.now();
    const inactiveState=pending?'waiting_login':login.status==='expired'?'login_expired':'not_configured';
    if(identity===wechatIdentity) {
      if(!valid && status.wechatState!==inactiveState)channelStatus('wechat',{state:inactiveState});
      return;
    }
    const previous=channels.get('wechat');channels.delete('wechat');await previous?.stop();wechatIdentity=identity;
    if(valid) {
      const channel=createWechatChannel({desktop,account,onStatus:update=>channelStatus('wechat',update)});
      channels.set('wechat',channel);await channel.start();
    }else channelStatus('wechat',{state:inactiveState});
  };
  try {
    control=await createControl(stop,async(id='feishu')=>{
      const channel=channels.get(id);if(!channel)throw new Error('这个通道尚未连接。');
      await channel.preview();
    });
    desktop=new DesktopClient(readJson('desktop-context.json',{}),{
      beforeCreateThread:async(context,args)=>{
        if(args.target?.type==='project') {
          const catalog=await desktop.call('list_projects');
          const project=catalog.projects?.find(p=>p.projectId===args.target.projectId);
          if(!project || project.projectKind!=='local' || (project.hostId && project.hostId!=='local'))return;
        }
        await prepareNewThreadCompat({bundleDir:__dirname,desktopPipePath:context.pipePath});
      }});
    const tools=await desktop.tools();
    if(!tools.some(tool=>tool.name==='send_message_to_thread'))throw new Error('当前桌面版没有提供消息转发能力');
    await desktop.call('list_threads',{limit:1});status.desktopConnected=true;saveStatus();
    await desktop.input.connect();status.messageTransport='desktop-user-input';saveStatus();
    const settings=config();
    if(settings.appId && settings.appSecret && settings.feishuEnabled!==false) {
      const channel=createFeishuChannel({desktop,settings,onStatus:update=>channelStatus('feishu',update)});
      channels.set('feishu',channel);await channel.start();
    }else channelStatus('feishu',{state:'not_configured'});
    await refreshWechat();
    status.state='running';saveStatus();
    timer=setInterval(async()=>{
      if(polling || stopping)return;polling=true;
      try {
        await refreshDesktop();
        await refreshWechat();
        await Promise.allSettled([...channels.values()].map(c=>c.poll()));
      }catch{status.lastRefreshErrorAt=Date.now();saveStatus();}
      finally{polling=false;}
    },5000);
  }catch(error) {
    status.state='failed';status.error=error.message;status.desktopConnected=false;saveStatus();
    await Promise.allSettled([...channels.values()].map(c=>c.stop()));
    desktop?.close();control?.close();try{fs.unlinkSync(lockPath);}catch{}
    console.error('桌面桥接启动失败；请用插件状态工具查看诊断。');process.exitCode=1;
  }
}
main().catch(()=>{console.error('桌面桥接发生错误。');process.exitCode=1;});
