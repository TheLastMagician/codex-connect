import {Client,WSClient,EventDispatcher,Domain,LoggerLevel} from '@larksuiteoapi/node-sdk';
import {Router} from '../router.mjs';
import {CardActions} from '../card-actions.mjs';
import {createSender} from '../outbound.mjs';
import {config,readJson,writeJson} from '../storage.mjs';
import {readLocalThreads} from '../catalog.mjs';
import {OperationAssistant} from '../assistant.mjs';

export function createFeishuChannel({desktop,settings,onStatus,operator=new OperationAssistant()}) {
  const state=readJson('state.json',{sessions:{},seen:{}});
  const saveState=()=>writeJson('state.json',state);
  const sdkOptions={appId:settings.appId,appSecret:settings.appSecret,domain:Domain.Feishu,
    loggerLevel:LoggerLevel.error,logger:{error:()=>onStatus({lastTransportErrorAt:Date.now()}),warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}}};
  const actions=new CardActions({state,saveState,getConfig:config});
  const send=createSender({client:new Client(sdkOptions),actions,state,saveState,getConfig:config});
  const router=new Router({desktop,getLocalThreads:readLocalThreads,getConfig:config,saveConfig:value=>writeJson('config.json',value),state,saveState,send,operator});
  const ws=new WSClient({...sdkOptions,onReady:()=>onStatus({state:'connected'}),onError:()=>onStatus({state:'failed'}),
    onReconnecting:()=>onStatus({state:'reconnecting'}),onReconnected:()=>onStatus({state:'connected'})});
  const dispatcher=new EventDispatcher({}).register({
    'im.message.receive_v1':event=>{try{router.accept(event);}catch{onStatus({lastReceiveErrorAt:Date.now()});}return {};},
    'card.action.trigger':event=>{
      try {
        const result=actions.consume(event);
        if(result.context && !router.acceptCard(result.context)) return {toast:{type:'warning',content:'服务忙，请稍后刷新列表。'}};
        onStatus({lastCardActionAt:Date.now()});return {toast:result.toast};
      }catch{return {toast:{type:'error',content:'操作未完成，请发送 /chats 刷新。'}};}
    }
  });
  return {id:'feishu',router,
    start:async()=>{onStatus({state:'connecting'});await ws.start({eventDispatcher:dispatcher});},
    stop:()=>{ws.close();},poll:()=>router.poll(),
    preview:async()=>{
      const sessions=Object.values(state.sessions).filter(s=>config().allowedOpenIds.includes(s.openId));
      if(sessions.length!==1) throw new Error('请在飞书发送 /projects 查看卡片。');
      const session=sessions[0];const previous=router.queues.get(session.chatId)||Promise.resolve();
      const work=previous.then(()=>router.handle({openId:session.openId,chatId:session.chatId,text:'/projects'}));router.queues.set(session.chatId,work);
      try{await work;}finally{if(router.queues.get(session.chatId)===work)router.queues.delete(session.chatId);}
    }
  };
}
