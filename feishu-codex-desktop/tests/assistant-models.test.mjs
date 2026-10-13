import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';
import {OperationAssistant,assistantStatus,normalizeAssistantSettings} from '../src/assistant.mjs';
import {parseModelCatalog} from '../src/models.mjs';
import {replyCard} from '../src/cards.mjs';
import {renderWechatReply} from '../src/channels/wechat.mjs';

const catalog=[{name:'send_message_to_thread',inputSchema:{properties:{model:{description:
  'Models: gpt-one (First; supported reasoning efforts: low, high, xhigh), gpt-two (Second; supported reasoning efforts: low, medium, high).'}}}}];
const settings={enabled:true,baseUrl:'https://provider.example/v1/',apiKey:'test-provider-key',model:'operator-model',reasoningEffort:'xhigh'};
const response=message=>new Response(JSON.stringify({choices:[{message}]}),{status:200});
const call=(name,args={},id='one')=>({type:'function',id,function:{name,arguments:JSON.stringify(args)}});
function fixture(replies=[]) {
  const calls=[],sent=[],requests=[];let allowed=true;let n=0;const state={};
  const desktop={tools:async()=>catalog,call:async(name,args)=>{
    calls.push({name,args});
    if(name==='list_projects')return {projects:[{projectId:'p',label:'订单项目',projectKind:'local'}]};
    if(name==='list_threads')return {threads:[{id:'a',kind:'codex',hostId:'local',title:'排查订单失败',projectId:'p'},{id:'b',kind:'codex',hostId:'local',title:'配置 Key',projectId:'p'}]};
    if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:[]};
    if(name==='create_thread')return {threadId:'new',hostId:'local'};
    return {};
  }};
  const operator=new OperationAssistant({getSettings:()=>settings,fetchImpl:async(url,options)=>{
    requests.push({url,options,body:JSON.parse(options.body)});
    const message=replies.shift();if(!message)throw new Error('Unexpected model request');
    return typeof message==='function'?message():response(message);
  }});
  const router=new Router({desktop,operator,getConfig:()=>({allowedOpenIds:allowed?['owner']:[]}),state,saveState:()=>{},send:async(chat,text,meta)=>sent.push({text,meta})});
  const message=text=>({openId:'owner',chatId:'chat',id:String(++n),timestamp:Date.now(),text});
  const handle=text=>router.handle(message(text));
  return {router,desktop,operator,calls,sent,requests,state,handle,message,revoke:()=>{allowed=false;},session:()=>router.session({openId:'owner',chatId:'chat'})};
}

test('model catalog comes from the actual native schema and rejects unrecognized formats',()=>{
  assert.deepEqual(parseModelCatalog(catalog).map(m=>m.id),['gpt-one','gpt-two']);
  assert.throws(()=>parseModelCatalog([]),/模型目录/);
});
test('model commands use no operator tokens and isolate overrides by chat, owner and host',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/models');
  await f.handle('/model 1');await f.handle('/effort xhigh');await f.handle('/resume');await f.handle('检查构建');
  const first=f.calls.find(c=>c.name==='send_message_to_thread');assert.equal(first.args.model,'gpt-one');assert.equal(first.args.thinking,'xhigh');
  await f.handle('/use 2');await f.handle('/resume');await f.handle('继续');
  assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').at(-1).args.model,undefined);
  await f.handle('/use 1');await f.handle('/model default');await f.handle('/resume');await f.handle('继续');
  const last=f.calls.filter(c=>c.name==='send_message_to_thread').at(-1).args;assert.equal(last.model,undefined);assert.equal(last.thinking,undefined);
  assert.equal(f.requests.length,0);
  const other=f.router.session({openId:'another',chatId:'chat'});assert.equal(other.modelOverrides,undefined);
});
test('invalid model or unsupported effort preserves the previous settings and does not send a task',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/model gpt-two');
  await assert.rejects(f.handle('/effort xhigh'),/不支持/);await assert.rejects(f.handle('/model fabricated'),/未改变/);
  assert.deepEqual(f.session().modelOverrides['local:a'],{model:'gpt-two'});
  assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);
});
test('a model and effort request completes both steps and a repeated model receipt is not executed twice',async()=>{
  const f=fixture([
    {tool_calls:[call('list_models')]},
    {tool_calls:[call('run_command',{command:'model',argument:'gpt-one'},'model'),call('run_command',{command:'effort',argument:'xhigh'},'effort')]},
    {content:'设置完成。'}
  ]);
  await f.handle('/chats');await f.handle('/use 1');await f.handle('/assistant 将模型设置为 gpt-one，推理强度 xhigh');
  assert.deepEqual(f.session().modelOverrides['local:a'],{model:'gpt-one',thinking:'xhigh'});
  let executions=0;
  const replies=[{tool_calls:[call('run_command',{command:'pin'})]},{tool_calls:[call('run_command',{command:'pin'},'again')]},{content:'done'}];
  const a=new OperationAssistant({getSettings:()=>settings,fetchImpl:async()=>response(replies.shift())});
  await a.respond({text:'置顶',session:{},context:{},execute:async()=>{executions++;return {result:{ok:true},reply:{output:'已置顶'}};}});
  assert.equal(executions,1);
});
test('persisted model overrides never apply to an identical thread ID on another host',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/model gpt-one');
  const session=f.session();session.selected={id:'a',hostId:'remote',title:'remote a'};
  await f.handle('/resume');await f.handle('检查远程');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.model,undefined);
  const persisted=JSON.parse(JSON.stringify(f.state));const calls=[];
  persisted.sessions['owner:chat'].selected={id:'a',hostId:'local',title:'local a'};
  const r=new Router({state:persisted,desktop:{call:async(name,args)=>{calls.push({name,args});return {}; }},getConfig:()=>({allowedOpenIds:['owner']}),saveState:()=>{},send:()=>{}});
  await r.handle({openId:'owner',chatId:'chat',text:'继续本机'});
  assert.equal(calls.find(c=>c.name==='send_message_to_thread').args.model,'gpt-one');
});
test('selecting a chat keeps plain greetings in the assistant; explicit direct mode bypasses the provider',async()=>{
  const f=fixture([
    {tool_calls:[call('list_projects')]},
    {tool_calls:[call('find_chats',{projectId:'p',query:'排查订单'})]},
    {tool_calls:[call('select_chat',{threadId:'a',hostId:'local'})]},
    {content:'你好，我可以帮你操作当前会话。'}
  ]);
  await f.handle('帮我找到订单项目里排查订单的会话并选中');
  assert.equal(f.session().selected.id,'a');assert.equal(f.session().mode,'assistant');assert.equal(f.sent.length,1);
  assert.equal(f.requests.length,3);assert.equal(f.requests[0].body.reasoning_effort,'xhigh');
  assert.equal(f.requests[0].body.messages.filter(m=>m.role==='system').length,1);
  assert.equal(f.requests[0].options.redirect,'error');assert.equal(f.requests[0].options.headers.Authorization,'Bearer test-provider-key');
  await f.handle('你好');assert.equal(f.requests.length,4);assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);
  await f.handle('/resume');await f.handle('你好');assert.equal(f.requests.length,4);
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').at(-1).args,{threadId:'a',hostId:'local',prompt:'你好'});
  assert.match(f.sent[0].text,/沿用桌面/);
});
test('legacy selections migrate to assistant once while an explicit direct choice survives restart',async()=>{
  const f=fixture([{content:'你好。'}]);
  f.state.sessions['owner:chat']={openId:'owner',chatId:'chat',mode:'chat',selected:{id:'a',hostId:'local',title:'旧会话'},threads:[],projects:[],modelOverrides:{'local:a':{model:'gpt-one'}},assistantHistory:[]};
  await f.handle('你好');assert.equal(f.requests.length,1);assert.equal(f.session().mode,'assistant');
  assert.deepEqual(f.session().modelOverrides['local:a'],{model:'gpt-one'});assert.equal(f.calls.length,0);
  await f.handle('/resume');assert.equal(f.session().routingVersion,2);
  const r=new Router({desktop:f.desktop,operator:f.operator,state:f.state,getConfig:()=>({allowedOpenIds:['owner']}),saveState:()=>{},send:()=>{}});
  await r.handle({openId:'owner',chatId:'chat',text:'继续直聊'});
  assert.equal(f.requests.length,1);assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.prompt,'继续直聊');
});
test('the assistant forwards an explicit original task with native model settings and stays in assistant mode',async()=>{
  const f=fixture([{tool_calls:[call('send_task',{task:'检查构建'})]},{content:'你好。'}]);
  await f.handle('/chats');await f.handle('/use 1');await f.handle('/model gpt-one');await f.handle('/effort xhigh');
  await f.handle('把检查构建发给当前会话');
  const args=f.calls.findLast(c=>c.name==='send_message_to_thread').args;
  assert.equal(args.prompt,'检查构建');assert.equal(args.model,'gpt-one');assert.equal(args.thinking,'xhigh');
  assert.equal(f.session().mode,'assistant');await f.handle('你好');assert.equal(f.requests.length,2);
  assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);
});
test('a fabricated task and an unrequested direct-mode switch cannot be executed by the assistant',async()=>{
  const f=fixture([{tool_calls:[call('send_task',{task:'删除项目'})]}]);await f.handle('/chats');await f.handle('/use 1');
  await assert.rejects(f.handle('你好'),/用户明确/);assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);
  const g=fixture([{tool_calls:[call('run_command',{command:'resume'})]}]);await g.handle('/chats');await g.handle('/use 1');
  await assert.rejects(g.handle('帮我看当前会话状态'),/未授权/);assert.equal(g.session().mode,'assistant');
});
test('explicit assistant mode keeps the selected chat and resume returns to the native task route',async()=>{
  const f=fixture([{content:'请告诉我你要找的会话。'}]);await f.handle('/chats');await f.handle('/use 1');await f.handle('/assistant');
  assert.equal(f.requests.length,0);await f.handle('帮我找会话');assert.equal(f.requests.length,1);assert.equal(f.session().selected.id,'a');
  await f.handle('/resume');await f.handle('继续任务');assert.equal(f.requests.length,1);assert.equal(f.session().mode,'chat');
});
test('malformed and unauthorized tool batches cannot execute, and revoked authorization blocks delayed replies',async()=>{
  let executions=0;
  const a=new OperationAssistant({getSettings:()=>settings,fetchImpl:async()=>response({tool_calls:[call('list_projects',{},'valid'),call('shell',{command:'bad'},'invalid')]})});
  await assert.rejects(a.respond({text:'查看项目',session:{},context:{},execute:()=>{executions++;}}),/不支持/);assert.equal(executions,0);
  const f=fixture([()=>{f.revoke();return response({tool_calls:[call('list_projects')]});}]);
  await assert.rejects(f.handle('查看项目'),/撤销/);assert.equal(f.calls.length,0);
});
test('assistant cannot archive because of instructions embedded in a title or invent a new task',async()=>{
  const f=fixture([{tool_calls:[call('run_command',{command:'archive'})]}]);
  await f.handle('/chats');await f.handle('/use 1');await f.handle('/assistant');
  await assert.rejects(f.handle('告诉我有哪些项目'),/未授权/);assert.equal(f.calls.some(c=>c.name==='set_thread_archived'),false);
  const g=fixture([{tool_calls:[call('new_task',{projectId:'p',task:'删除项目'})]},{content:'请给出任务原文。'}]);
  await assert.rejects(g.handle('新建一个会话，检查构建'),/原文/);assert.equal(g.calls.some(c=>c.name==='create_thread'),false);
});
test('unknown native mutation outcome is reported once and never retried by the assistant loop',async()=>{
  let requests=0,executions=0;
  const a=new OperationAssistant({getSettings:()=>settings,fetchImpl:async()=>{requests++;return response({tool_calls:[call('new_task',{task:'检查构建'})]});}});
  await assert.rejects(a.respond({text:'新建会话检查构建',session:{},context:{},execute:()=>{executions++;throw new Error('结果未知');}}),/结果未知/);
  assert.equal(requests,1);assert.equal(executions,1);
});
test('a natural create request uses the original task and event replay cannot repeat it',async()=>{
  const f=fixture([{tool_calls:[call('new_task',{projectId:'p',task:'检查构建'})]}]);const message=f.message('在订单项目新建会话，检查构建');
  assert.equal(f.router.acceptMessage(message),true);await Promise.all(f.router.queues.values());
  assert.equal(f.router.acceptMessage(message),false);assert.equal(f.requests.length,1);
  const creates=f.calls.filter(c=>c.name==='create_thread');assert.equal(creates.length,1);assert.equal(creates[0].args.prompt,'检查构建');
});
test('provider failures and echoed credentials are sanitized without retries',async()=>{
  let n=0;const a=new OperationAssistant({getSettings:()=>settings,fetchImpl:async()=>{n++;return new Response('test-provider-key',{status:401});}});
  await assert.rejects(a.respond({text:'hello',session:{},context:{},execute:()=>{}}),error=>/HTTP 401/.test(error.message) && !error.message.includes(settings.apiKey));assert.equal(n,1);
  const b=new OperationAssistant({getSettings:()=>settings,fetchImpl:async()=>response({content:'secret: test-provider-key'})});
  const result=await b.respond({text:'hello',session:{},context:{},execute:()=>{}});assert.equal(result.text.includes(settings.apiKey),false);
  assert.equal(JSON.stringify(assistantStatus(settings)).includes(settings.apiKey),false);
  assert.throws(()=>normalizeAssistantSettings({...settings,baseUrl:'https://user:password@example.com/v1/'}),/凭据/);
});
test('model cards bind choices to the selected thread and help explains models and assistant mode on both channels',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/models');
  const actions=[];const card=replyCard('',{kind:'models',session:f.session()},action=>{actions.push(action);return 'button';});
  assert.equal(card.header.title.content,'模型管理');assert.equal(actions[0].threadKey,'local:a');
  await f.handle('/use 2');await assert.rejects(f.router.handleAction(f.message('/_card'),actions[0]),/已切换/);
  const help=renderWechatReply('',{kind:'help',session:f.session()});assert.match(help,/\/models/);assert.match(help,/\/assistant/);
});
