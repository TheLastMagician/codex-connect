import {feishuBots,feishuIdentity} from './connections.mjs';
import {readJson} from './storage.mjs';
import {readWechatAccount} from './wechat-storage.mjs';
import {createFeishuChannel} from './channels/feishu.mjs';
import {createWechatChannel} from './channels/wechat.mjs';

export class ChannelManager {
  constructor({desktop,onStatus,listBots=feishuBots,wechatAccount=readWechatAccount,
    createFeishu=createFeishuChannel,createWechat=createWechatChannel,isPaused=()=>false}) {
    Object.assign(this,{desktop,onStatus,listBots,wechatAccount,createFeishu,createWechat,isPaused});
    this.channels=new Map();this.identities=new Map();this.retryAt=new Map();this.queue=Promise.resolve();this.stopped=false;
  }
  reconcile() {const work=this.queue.catch(()=>{}).then(()=>this.refresh());this.queue=work;return work;}
  async refresh() {
    if(this.stopped)return;
    const desired=new Map(),paused=this.isPaused();
    for(const settings of this.listBots()) {
      const id=settings.id==='default'?'feishu':`feishu:${settings.id}`;
      if(!paused && settings.enabled && settings.appId && settings.appSecret)desired.set(id,{identity:feishuIdentity(settings),create:onStatus=>this.createFeishu({desktop:this.desktop,settings,onStatus})});
      else this.onStatus(id,{state:paused?'paused':settings.enabled?'not_configured':'disabled'});
    }
    const account=this.wechatAccount(),valid=account.token && account.botId && account.ownerUserId;
    if(!paused && account.enabled && valid)desired.set('wechat',{identity:JSON.stringify([account.botId,account.ownerUserId,account.token]),create:onStatus=>this.createWechat({desktop:this.desktop,account,onStatus})});
    else {
      const login=readJson('wechat-login.json',{}),pending=['wait','scaned','need_verifycode'].includes(login.status) && login.expiresAt>Date.now();
      this.onStatus('wechat',{state:paused?'paused':pending?'waiting_login':valid?'disabled':login.status==='expired'?'login_expired':'not_configured'});
    }
    for(const [id,channel] of this.channels)if(!desired.has(id) || desired.get(id).identity!==this.identities.get(id)) {
      this.channels.delete(id);this.identities.delete(id);this.retryAt.delete(id);
      await Promise.resolve().then(()=>channel.stop()).catch(()=>{});
    }
    await Promise.allSettled([...desired].map(async([id,item])=>{
      if(this.stopped || this.channels.has(id))return;
      const failed=this.retryAt.get(id);if(failed?.identity===item.identity && failed.at>Date.now())return;
      let channel;
      const report=update=>{if(!this.stopped && this.channels.get(id)===channel)this.onStatus(id,update);};
      try {
        channel=item.create(report);this.channels.set(id,channel);this.identities.set(id,item.identity);
        await channel.start();this.retryAt.delete(id);
      }catch {
        this.channels.delete(id);this.identities.delete(id);this.retryAt.set(id,{identity:item.identity,at:Date.now()+30000});
        this.onStatus(id,{state:'failed'});if(channel)await Promise.resolve().then(()=>channel.stop()).catch(()=>{});
      }
    }));
  }
  async poll() {await Promise.allSettled([...this.channels.values()].map(channel=>channel.poll()));}
  async stop() {
    this.stopped=true;await this.queue.catch(()=>{});
    await Promise.allSettled([...this.channels.values()].map(channel=>Promise.resolve().then(()=>channel.stop())));
    this.channels.clear();this.identities.clear();
  }
}
