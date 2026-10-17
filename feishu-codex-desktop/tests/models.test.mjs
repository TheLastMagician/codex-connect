import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from '../src/router.mjs';
import {parseModelCatalog} from '../src/models.mjs';
import {replyCard} from '../src/cards.mjs';
import {renderWechatReply} from '../src/channels/wechat.mjs';

const catalog=[{name:'send_message_to_thread',inputSchema:{properties:{model:{description:
  'Models: gpt-one (First; supported reasoning efforts: low, high, xhigh), gpt-two (Second; supported reasoning efforts: low, medium, high).'}}}}];
function fixture(state={}) {
  const calls=[],sent=[];let n=0;
  const desktop={tools:async()=>catalog,call:async(name,args)=>{
    calls.push({name,args});
    if(name==='list_projects')return {projects:[{projectId:'p',label:'订单项目',projectKind:'local'}]};
    if(name==='list_threads')return {threads:[{id:'a',kind:'codex',hostId:'local',title:'排查订单失败',projectId:'p'},{id:'b',kind:'codex',hostId:'local',title:'配置 Key',projectId:'p'}]};
    if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:[]};
    if(name==='create_thread')return {threadId:'new',hostId:'local'};
    if(name==='fork_thread')return {threadId:'forked',hostId:'local'};
    return {};
  }};
  const router=new Router({desktop,getConfig:()=>({allowedOpenIds:['owner']}),state,saveState:()=>{},send:async(chat,text,meta)=>sent.push({text,meta})});
  const message=text=>({openId:'owner',chatId:'chat',id:String(++n),timestamp:Date.now(),text});
  return {router,desktop,calls,sent,state,message,handle:text=>router.handle(message(text)),session:()=>router.session({openId:'owner',chatId:'chat'})};
}
test('model catalog comes from the actual native schema and rejects unrecognized formats',()=>{
  assert.deepEqual(parseModelCatalog(catalog).map(m=>m.id),['gpt-one','gpt-two']);assert.throws(()=>parseModelCatalog([]),/模型目录/);
});
test('model commands isolate overrides by chat, owner and host and reset to desktop defaults',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/models');await f.handle('/model 1');await f.handle('/effort xhigh');await f.handle('检查构建');
  const first=f.calls.find(c=>c.name==='send_message_to_thread');assert.equal(first.args.model,'gpt-one');assert.equal(first.args.thinking,'xhigh');
  await f.handle('/use 2');await f.handle('继续');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.model,undefined);
  await f.handle('/use 1');await f.handle('/model default');await f.handle('继续');const last=f.calls.findLast(c=>c.name==='send_message_to_thread').args;
  assert.equal(last.model,undefined);assert.equal(last.thinking,undefined);assert.equal(f.router.session({openId:'another',chatId:'chat'}).modelOverrides,undefined);
});
test('invalid model or unsupported effort preserves the previous settings and does not send a task',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/model gpt-two');
  await assert.rejects(f.handle('/effort xhigh'),/不支持/);await assert.rejects(f.handle('/model fabricated'),/未改变/);
  assert.deepEqual(f.session().modelOverrides['local:a'],{model:'gpt-two'});assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);
});
test('persisted model overrides never apply to an identical thread ID on another host',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/model gpt-one');
  f.router.selectThread(f.session(),{id:'a',hostId:'remote',title:'remote a'});await f.handle('检查远程');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.model,undefined);
  const persisted=structuredClone(f.state);persisted.sessions['owner:chat'].selected={id:'a',hostId:'local',title:'local a'};
  const restored=fixture(persisted);await restored.handle('继续本机');assert.equal(restored.calls.findLast(c=>c.name==='send_message_to_thread').args.model,'gpt-one');
});
test('commands, numbers and both generations of selection cards route the next text directly',async()=>{
  for(const route of ['command','number','card','legacy-card']) {
    const f=fixture();await f.handle('/chats');
    if(route==='command')await f.handle('/use 1');else if(route==='number')await f.handle('1');
    else await f.router.handleAction(f.message('/_card'),{kind:route==='card'?'select':'direct',thread:f.session().threads[0]});
    assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);await f.handle('1');await f.handle('你好，继续这个会话。');
    assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['1','你好，继续这个会话。']);
    assert.ok(f.calls.filter(c=>c.name==='send_message_to_thread').every(c=>c.args.threadId==='a'));
  }
});
test('new and forked chats accept the next message without another routing mode',async()=>{
  const f=fixture();await f.handle('/projects');await f.handle('/new 1 | 检查构建');await f.handle('继续看测试');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.threadId,'new');
  await f.handle('/fork');await f.handle('接着处理');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.threadId,'forked');
});
test('old session mode and management history are removed while selection and model settings survive',async()=>{
  const state={sessions:{'owner:chat':{openId:'owner',chatId:'chat',routingVersion:3,mode:'assistant',selected:{id:'a',hostId:'local'},threads:[],projects:[],
    modelOverrides:{'local:a':{model:'gpt-one'}},assistantHistory:[{role:'user',content:'old private management request'}]}}};
  const f=fixture(state);assert.equal(f.session().assistantHistory,undefined);assert.equal(f.session().mode,undefined);assert.equal(f.session().routingVersion,undefined);
  await f.handle('你好');assert.equal(f.calls.findLast(c=>c.name==='send_message_to_thread').args.model,'gpt-one');
  await assert.rejects(f.handle('/assistant anything'),/没有这个指令/);assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);
});
test('unselected text only asks for a target; old assistant commands and callbacks cannot execute',async()=>{
  const f=fixture();await assert.rejects(f.handle('你好'),/还没选择会话/);assert.equal(f.calls.length,0);
  for(const command of ['/assistant','/resume'])await assert.rejects(f.handle(command),/没有这个指令/);
  await assert.rejects(f.router.handleAction(f.message('/_card'),{kind:'command',command:'assistant'}),/不受支持/);assert.equal(f.calls.length,0);
});
test('model cards remain bound to their selected target and both channels omit removed controls',async()=>{
  const f=fixture();await f.handle('/chats');await f.handle('/use 1');await f.handle('/models');
  const actions=[];replyCard('',{kind:'models',session:f.session()},a=>{actions.push(a);return 'button';});assert.equal(actions[0].threadKey,'local:a');
  assert.ok(actions.every(a=>a.command!=='assistant' && a.command!=='resume'));
  await f.handle('/use 2');await assert.rejects(f.router.handleAction(f.message('/_card'),actions[0]),/已切换/);
  await f.handle('/help');assert.doesNotMatch(f.sent.at(-1).text,/操作助手|\/assistant|\/resume/);
  const help=renderWechatReply('',{kind:'help',session:f.session()});assert.match(help,/\/models/);assert.doesNotMatch(help,/操作助手|\/assistant|\/resume/);
  const labels=[];const card=replyCard('内容',{session:f.session()},a=>{labels.push(a);return 'token';});assert.doesNotMatch(JSON.stringify(card),/操作助手|返回当前会话/);
  assert.ok(labels.some(a=>a.command==='chats'));assert.ok(labels.some(a=>a.command==='models'));
});
