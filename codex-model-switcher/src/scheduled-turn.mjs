import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopReader} from './desktop-ipc.mjs';
import {withAppServer} from './app-server.mjs';
import {readConfig,requireSelection} from './providers.mjs';
import {openThread,historyModel} from './service.mjs';

export function scheduledTurnRequest(job,run){
  return {threadId:job.threadId,clientUserMessageId:run.clientUserMessageId||randomUUID(),
    input:[{type:'text',text:`[插件定时任务：${job.name} · ${run.day} ${job.time} 北京时间]\n${job.prompt}`,text_elements:[]}],
    model:job.model,effort:job.effort,
    collaborationMode:{mode:'default',settings:{model:job.model,reasoning_effort:job.effort,developer_instructions:null}}};
}
export async function scheduledPreflight(job,{rpc=withAppServer}={}){
  return rpc(async c=>{
    const thread=(await c.request('thread/read',{threadId:job.threadId,includeTurns:false})).thread;
    if(thread.id!==job.threadId||thread.modelProvider!==job.providerId)throw new Error('会话供应商已改变，本次尚未发送。');
    const turns=await c.request('thread/turns/list',{threadId:job.threadId,limit:1,itemsView:'notLoaded'});
    if(thread.status?.type==='active'||turns.data?.some(t=>t.status==='inProgress'))throw new Error('会话正在运行，等待空闲后再发送。');
    const history=await historyModel(thread);
    if(history.status!=='recorded')throw new Error('无法核对历史上下文模型，请先打开会话检查。');
    if(history.model!==job.model)throw new Error(`历史上下文仍是 ${history.model}；请在原会话切换模型并执行 /compact 后再启用。`);
    return thread;
  });
}
export async function dispatchScheduled(job,run,beforeSubmit,{rpc=withAppServer,Reader=DesktopReader,open=openThread,read=readConfig,sleep=delay}={}){
  requireSelection(read(),job.providerId,job.model);
  await scheduledPreflight(job,{rpc});
  const reader=new Reader({timeoutMs:12000});
  try{
    await reader.connect();let settings=await reader.settings(job.threadId);
    if(!settings){await open(job.threadId);for(let i=0;i<40&&!settings;i++){await sleep(500);settings=await reader.settings(job.threadId);}}
    if(settings?.resumeState!=='resumed')throw new Error('Codex 尚未完成加载目标会话，本次尚未发送。');
    await reader.setModel(job.threadId,job.providerId,job.model,job.effort,{verifiedStoredProvider:job.providerId});
    await scheduledPreflight(job,{rpc});
    const owner=await reader.request('thread-owner-discovery',{hostId:'local',conversationId:job.threadId});
    if(owner.resultType!=='success'||!owner.handledByClientId)throw new Error('目标会话未连接，本次尚未发送。');
    beforeSubmit();
    const result=await reader.request('thread-follower-start-turn',{conversationId:job.threadId,turnStart:{request:scheduledTurnRequest(job,run),context:{inheritThreadSettings:true}}},{targetClientId:owner.handledByClientId});
    if(result.resultType!=='success')throw new Error('桌面未确认定时消息。');
    return {turnId:result.result?.result?.turn?.id||null,requestedModel:job.model,requestedEffort:job.effort};
  }finally{reader.close();}
}
export async function observeScheduled(job,run,{rpc=withAppServer}={}){
  return rpc(async c=>{
    const page=await c.request('thread/turns/list',{threadId:job.threadId,limit:30,itemsView:'notLoaded'});
    const turn=page.data?.find(t=>t.id===run.turnId);
    if(!turn||turn.status==='inProgress')return null;
    if(turn.status!=='completed')return {status:turn.status,note:'定时回合未成功完成，请打开原会话查看错误。'};
    const {thread}=await c.request('thread/read',{threadId:job.threadId,includeTurns:false});
    let model,effort;
    if(thread.path&&fs.statSync(thread.path).size<=128*1024*1024){
      const input=fs.createReadStream(thread.path,{encoding:'utf8',signal:AbortSignal.timeout(5000)}),lines=createInterface({input,crlfDelay:Infinity});
      try{for await(const line of lines){if(!line.includes(run.turnId)||!line.includes('turn_context'))continue;let d;try{d=JSON.parse(line);}catch{continue;}if(d.type==='turn_context'&&d.payload?.turn_id===run.turnId){model=d.payload.model;effort=d.payload.effort;}}}finally{lines.close();input.destroy();}
    }
    const expectedModel=run.requestedModel||job.model,expectedEffort=run.requestedEffort||job.effort;
    if(model&&model!==expectedModel||effort&&effort!==expectedEffort)return {status:'model_mismatch',observedModel:model||null,observedEffort:effort||null,note:'实际回合模型或强度与提交设置不一致，任务已暂停。'};
    const verified=model===expectedModel&&effort===expectedEffort;
    return {status:verified?'completed_verified':'completed_unverified',observedModel:model||null,observedEffort:effort||null,note:verified?'回合已完成，历史记录中的模型和强度已核对。':'回合已完成，但实际模型或强度记录暂无法核对。'};
  });
}
