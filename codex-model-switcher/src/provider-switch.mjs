import {withAppServer} from './app-server.mjs';

// Resume in a separate short-lived server: a loaded server ignores provider overrides.
// Use only official RPCs; leave rollout contents, credentials and global config alone.
export async function persistProviderSwitch(thread,selection,effort,{rpc=withAppServer}={}){
  const expected={id:thread.id,provider:thread.modelProvider,cwd:thread.cwd,projectId:thread.projectId};
  const checkIdentity=current=>{
    if(current?.id!==expected.id||current.cwd!==expected.cwd||current.projectId!==expected.projectId)throw new Error('会话身份、项目或目录已变化，未继续切换。');
  };
  await rpc(async c=>{
    const current=(await c.request('thread/read',{threadId:thread.id,includeTurns:false})).thread;
    checkIdentity(current);
    if(current.modelProvider!==expected.provider)throw new Error('会话供应商已被其他操作修改，请刷新后重试。');
    const turns=await c.request('thread/turns/list',{threadId:thread.id,limit:1,itemsView:'notLoaded'});
    if(current.status?.type==='active'||turns.data?.some(t=>t.status==='inProgress'))throw new Error('该会话正在运行，请等待当前回复完成后再切换供应商。');
  });
  await rpc(async c=>{
    const result=await c.request('thread/resume',{threadId:thread.id,...selection,excludeTurns:true,config:{model_reasoning_effort:effort,...(selection.modelProvider!=='openai'?{web_search:'disabled'}:{})}});
    checkIdentity(result.thread);
    if(result.modelProvider!==selection.modelProvider||result.thread.modelProvider!==selection.modelProvider||result.model!==selection.model)throw new Error('底层未确认新供应商，请关闭该会话后重试。');
    await c.request('thread/settings/update',{threadId:thread.id,model:selection.model,effort,serviceTier:null,collaborationMode:{mode:'default',settings:{model:selection.model,reasoning_effort:effort,developer_instructions:null}}});
  });
  // A fresh process proves this was saved rather than only changed in one server's cache.
  const saved=await rpc(async c=>{
    const result=await c.request('thread/resume',{threadId:thread.id,excludeTurns:true});
    checkIdentity(result.thread);
    if(result.modelProvider!==selection.modelProvider||result.thread.modelProvider!==selection.modelProvider||result.model!==selection.model||result.reasoningEffort!==effort)throw new Error('重新加载后供应商、模型或强度未能核对，请对同一会话重试。');
    return result.thread;
  });
  return saved;
}
