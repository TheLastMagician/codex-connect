import {Client,WSClient,EventDispatcher,Domain,LoggerLevel} from '@larksuiteoapi/node-sdk';
import {Router,parseMessage,equalSecret,fingerprint} from '../router.mjs';
import {FixedChatRouter,fixedReply} from '../fixed-router.mjs';
import {CardActions} from '../card-actions.mjs';
import {createSender} from '../outbound.mjs';
import {fixedReplyCards} from '../fixed-cards.mjs';
import {readJson,writeJson} from '../storage.mjs';
import {readLocalThreads} from '../catalog.mjs';
import {feishuBot,feishuIdentity,botStateName,saveBotRuntime,rememberFeishuRequest,requireBotId,allowsFeishuUser} from '../connections.mjs';

export function createFeishuChannel({desktop,settings,onStatus=()=>{},
  getSettings=()=>feishuBot(settings.id),sdk={Client,WSClient,EventDispatcher},
  loadState=()=>readJson(botStateName(settings),{sessions:{},seen:{}}),save,
  saveSettings=value=>saveBotRuntime(settings.id,value),rememberRequest=message=>rememberFeishuRequest(settings.id,message)}) {
  const seenName=`feishu-seen-${requireBotId(settings.id)}.json`,state=loadState();
  state.seen={...readJson(seenName,{}),...state.seen};
  const saveState=()=>{
    // Deduplication survives mode changes and rebinding while selections and
    // reply watches stay isolated to their original destination.
    const seen={...readJson(seenName,{}),...state.seen};for(const [key,at] of Object.entries(seen))if(Date.now()-at>86400000)delete seen[key];
    // Save the durable input and its deduplication mark in the same profile
    // before updating the shared mark used across rebinding.
    const saved=save?save(state):writeJson(botStateName(settings),state);
    writeJson(seenName,seen);return saved;
  };
  const identity=feishuIdentity(settings);let stopped=false;
  const active=()=>{const current=getSettings();return !stopped && current?.enabled && identity===feishuIdentity(current);};
  const getConfig=()=>{const current=getSettings()||{};return {...current,allowedOpenIds:active()?current.allowedOpenIds||[]:[],
    ...(settings.mode==='fixed'?{pairing:undefined,cardActionsEnabled:false}:{})};};
  const sdkOptions={appId:settings.appId,appSecret:settings.appSecret,domain:Domain.Feishu,
    loggerLevel:LoggerLevel.error,logger:{error:()=>onStatus({lastTransportErrorAt:Date.now()}),warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}}};
  const client=new sdk.Client(sdkOptions),actions=new CardActions({state,saveState,getConfig});
  let botOpenId,identityRequest,retryIdentityAt=0,pendingMentions=0;
  const refreshBotIdentity=()=>{
    if(botOpenId || !active() || Date.now()<retryIdentityAt)return Promise.resolve();
    if(identityRequest)return identityRequest;
    identityRequest=(async()=>{
      try {
        const result=await client.request({method:'GET',url:'/open-apis/bot/v3/info',timeout:5000});
        if(result?.code!==0 || typeof result.bot?.open_id!=='string' || !/^ou_[A-Za-z0-9_-]+$/.test(result.bot.open_id))throw new Error('identity unavailable');
        botOpenId=result.bot.open_id;if(active())onStatus({groupMentionReady:true});
      }catch{retryIdentityAt=Date.now()+30000;if(active())onStatus({groupMentionReady:false,lastBotIdentityErrorAt:Date.now()});}
      finally{identityRequest=null;}
    })();return identityRequest;
  };
  const authorized=openId=>active() && allowsFeishuUser(getSettings(),openId);
  const fullSend=createSender({client,actions,state,saveState,getConfig,canSend:authorized});
  const send=async(chatId,text,meta={})=>{
    const openId=meta.openId||meta.session?.openId||Object.values(state.sessions||{}).find(s=>s.chatId===chatId)?.openId;
    if(!authorized(openId))return;
    if(settings.mode!=='fixed')return fullSend(chatId,text,meta);
    const reply=fixedReply(text,meta);if(reply===null)return;
    const session=meta.session||state.sessions?.[`${openId}:${chatId}`];
    const group=(meta.chatType||session?.chatType)==='group';
    const mentionIds=group?(meta.replyOpenIds||[openId]).filter(authorized):[];
    for(const card of fixedReplyCards(reply,{botName:getSettings()?.name||settings.name,kind:meta.kind,mentionIds})) {
      if(!authorized(openId))return;
      const result=await client.im.v1.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(card)}});
      if(result.code!==0)throw new Error('飞书卡片发送失败，请检查机器人权限');
    }
  };
  const options={desktop,getLocalThreads:readLocalThreads,getConfig,saveConfig:saveSettings,state,saveState,send,isAuthorized:authorized,
    reportDeliveryFailure:record=>onStatus({lastDeliveryFailure:record})};
  const router=settings.mode==='fixed'?new FixedChatRouter({...options,thread:settings.thread,isActive:active}):new Router(options);
  const receive=event=>{
    const message=parseMessage(event,{botOpenId,appId:settings.appId});
    if(!active() || !message || !Number.isFinite(message.timestamp) || Math.abs(Date.now()-message.timestamp)>600000)return;
    const current=getConfig(),pair=message.text.match(/^\/pair\s+(\S+)$/);
    const canPair=settings.mode!=='fixed' && message.chatType!=='group' && pair && current.pairing?.expiresAt>Date.now() && equalSecret(pair[1],current.pairing.code);
    if(!authorized(message.openId) && !canPair){state.seen[fingerprint(message)]=Date.now();saveState();rememberRequest(message);onStatus({lastAccessRequestAt:Date.now()});return;}
    if(message.mentionOnly) {
      const key=fingerprint(message);if(state.seen[key])return;state.seen[key]=Date.now();saveState();
      void send(message.chatId,'我在。请在 @机器人 后写上你的问题。',{kind:'notice',openId:message.openId,chatType:message.chatType}).catch(()=>onStatus({lastReceiveErrorAt:Date.now()}));return;
    }
    router.acceptMessage(message);
  };
  const ws=new sdk.WSClient({...sdkOptions,onReady:()=>onStatus({state:'connected'}),onError:()=>onStatus({state:'failed'}),
    onReconnecting:()=>onStatus({state:'reconnecting'}),onReconnected:()=>onStatus({state:'connected'})});
  const dispatcher=new sdk.EventDispatcher({}).register({
    'im.message.receive_v1':event=>{
      try {
        if(!active())return {};
        if(event?.message?.chat_type==='group' && !botOpenId) {
          if(pendingMentions>=20 || !event.message.mentions?.length)return {};
          pendingMentions++;
          void refreshBotIdentity().then(()=>receive(event)).catch(()=>onStatus({lastReceiveErrorAt:Date.now()})).finally(()=>pendingMentions--);
        }else receive(event);
      }catch{onStatus({lastReceiveErrorAt:Date.now()});}return {};
    },
    'card.action.trigger':event=>{
      try {
        if(!active() || settings.mode==='fixed')return {};
        const result=actions.consume(event);
        if(result.context && !router.acceptCard(result.context)) return {toast:{type:'warning',content:'服务忙，请稍后刷新列表。'}};
        onStatus({lastCardActionAt:Date.now()});return {toast:result.toast};
      }catch{return {toast:{type:'error',content:'操作未完成，请发送 /chats 刷新。'}};}
    }
  });
  return {id:settings.id==='default'?'feishu':`feishu:${settings.id}`,router,
    start:async()=>{onStatus({state:'connecting'});void refreshBotIdentity();await ws.start({eventDispatcher:dispatcher});},
    stop:()=>{stopped=true;router.stop?.();ws.close();},poll:()=>{void refreshBotIdentity();return active()?router.poll():undefined;},
    preview:async()=>{
      if(settings.mode==='fixed')throw new Error('固定会话机器人只支持聊天');
      const sessions=Object.values(state.sessions).filter(s=>getConfig().allowedOpenIds.includes(s.openId));
      if(sessions.length!==1) throw new Error('请在飞书发送 /projects 查看卡片。');
      const session=sessions[0];const previous=router.queues.get(session.chatId)||Promise.resolve();
      const work=previous.then(()=>router.handle({openId:session.openId,chatId:session.chatId,text:'/projects'}));router.queues.set(session.chatId,work);
      try{await work;}finally{if(router.queues.get(session.chatId)===work)router.queues.delete(session.chatId);}
    }
  };
}
