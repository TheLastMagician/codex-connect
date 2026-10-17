import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-connections-test-'));
process.env.FEISHU_CODEX_DATA_DIR=folder;
delete process.env.FEISHU_APP_ID;delete process.env.FEISHU_APP_SECRET;
const {readJson,writeJson}=await import('../src/storage.mjs');
const {feishuBots,saveFeishuBot,publicBot,botStateName,rememberFeishuRequest,authorizeFeishuUser,deleteFeishuBot,allowsFeishuUser}=await import('../src/connections.mjs');
const {createFeishuChannel}=await import('../src/channels/feishu.mjs');
const {ChannelManager}=await import('../src/channel-manager.mjs');
test.beforeEach(()=>{for(const name of fs.readdirSync(folder))fs.unlinkSync(path.join(folder,name));});
test.after(()=>{assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-connections-test-'));fs.rmSync(folder,{recursive:true,force:true});});
const binding={id:'real-chat',hostId:'local',title:'真实会话'};
const botInput={name:'产线助手',appId:'cli_0000000000000002',appSecret:'fixture-secret',mode:'fixed',thread:binding};

test('legacy credentials, pairing and selected chats are preserved; public profiles never contain secrets',()=>{
  writeJson('config.json',{appId:'cli_0000000000000001',appSecret:'legacy-secret',allowedOpenIds:['original'],pairing:{code:'private-pair'},cardActionsEnabled:true});
  const bot=feishuBots()[0];assert.equal(botStateName(bot),'state.json');assert.equal(bot.mode,'full');
  saveFeishuBot({id:'default',name:'原来的飞书',appSecret:'',enabled:false});
  const saved=readJson('config.json',{});assert.equal(saved.appSecret,'legacy-secret');assert.deepEqual(saved.allowedOpenIds,['original']);assert.equal(saved.pairing.code,'private-pair');
  assert.ok(!JSON.stringify(publicBot(feishuBots()[0])).includes('legacy-secret'));assert.ok(!JSON.stringify(publicBot(bot)).includes('private-pair'));
});
test('additional bots require a binding, cannot duplicate an app and isolate state by bot and destination',()=>{
  assert.throws(()=>saveFeishuBot({...botInput,thread:null}),/选择/);
  const first=saveFeishuBot(botInput);assert.throws(()=>saveFeishuBot(botInput),/重复/);
  const second=saveFeishuBot({...botInput,appId:'cli_0000000000000003'});
  assert.notEqual(botStateName(first),botStateName(second));
  assert.notEqual(botStateName(first),botStateName({...first,thread:{...binding,id:'another'}}));
  saveFeishuBot({id:first.id,enabled:false,appSecret:''});assert.equal(feishuBots().find(b=>b.id===first.id).appSecret,'fixture-secret');
  deleteFeishuBot(second.id);assert.equal(feishuBots().length,2);assert.throws(()=>deleteFeishuBot('default'),/主机器人/);
});
test('local approval can only approve a real application and never stores or replays its message contents',()=>{
  const bot=saveFeishuBot(botInput);assert.throws(()=>authorizeFeishuUser(bot.id,'invented',true),/真实使用申请/);
  rememberFeishuRequest(bot.id,{openId:'owner',text:'private message body'});
  assert.ok(!JSON.stringify(readJson('feishu-requests.json',{})).includes('private message body'));
  assert.deepEqual(authorizeFeishuUser(bot.id,'owner',true).allowedOpenIds,['owner']);
  assert.deepEqual(authorizeFeishuUser(bot.id,'owner',false).allowedOpenIds,[]);
});
function channelFixture(thread=binding,{identity=async()=>({code:0,bot:{open_id:'ou_robot'}}),accessMode='approved',mode='fixed',state={}}={}) {
  const settings={...botInput,thread,id:'default',enabled:true,allowedOpenIds:['owner'],accessMode,mode};const calls=[],sent=[],requests=[],statuses=[];let events;
  const sdk={Client:class {constructor(){this.im={v1:{message:{create:async args=>{sent.push(args);return {code:0};}}}};}request(){return identity();}},
    WSClient:class {async start({eventDispatcher}){events=eventDispatcher;}close(){}},EventDispatcher:class {register(value){return value;}}};
  let snapshot={thread:{status:{type:'idle'}},turns:[{id:'old-turn',status:'completed',items:[{type:'agentMessage',id:'old',text:'旧回复'}]}]};
  const desktop={call:async(name,args,options)=>{calls.push({name,args});options?.beforeSend?.();if(name==='read_thread')return snapshot;return {};}};
  const channel=createFeishuChannel({desktop,settings:structuredClone(settings),getSettings:()=>settings,sdk,operator:{run:()=>assert.fail('Fixed bot cannot invoke operator')},loadState:()=>state,save:()=>{},rememberRequest:m=>requests.push(m),onStatus:update=>statuses.push(update)});
  const event=(text,owner='owner',id=Math.random().toString())=>({sender:{sender_type:'user',sender_id:{open_id:owner}},message:{message_id:id,chat_id:'private-chat',chat_type:'p2p',message_type:'text',create_time:String(Date.now()),content:JSON.stringify({text})}});
  return {channel,calls,sent,settings,requests,statuses,desktop,event,events:()=>events,setSnapshot:value=>snapshot=value};
}
test('a full bot retains its selected target through a transient read and exposes only redacted failure metadata',async()=>{
  const state={sessions:{'owner:private-chat':{openId:'owner',chatId:'private-chat',selected:binding,mode:'chat',routingVersion:3}}};
  const f=channelFixture(binding,{mode:'full',state});await f.channel.start();const original=f.desktop.call;let reads=0;
  f.desktop.call=async(name,args,options)=>{if(name==='read_thread' && ++reads===1)throw Error('connection lost with sensitive-data');return original(name,args,options);};
  try {
    await receive(f,f.event('private task body'));
    assert.equal(reads,2);assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);
    assert.equal(state.sessions['owner:private-chat'].selected.id,binding.id);
    const failure=f.statuses.find(s=>s.lastDeliveryFailure).lastDeliveryFailure;
    assert.deepEqual(Object.keys(failure).sort(),['at','stage','reason','retrying','threadId','hostId'].sort());
    assert.equal(failure.reason,'connection');assert.equal(failure.retrying,true);
    assert.doesNotMatch(JSON.stringify(failure),/sensitive-data|private task body/);
    assert.equal(state.deliveryFailures.length,1);
  }finally{f.channel.stop();}
});
function groupEvent(f,text,{owner='owner',id=Math.random().toString(),chat='group-chat',bot='ou_robot',mentions}={}) {
  const event=f.event(text,owner,id);Object.assign(event.message,{chat_type:'group',chat_id:chat,
    mentions:mentions||[{key:'@_user_1',id:{open_id:bot},name:'Codex'}]});return event;
}
async function receive(f,event){f.events()['im.message.receive_v1'](event);await new Promise(resolve=>setImmediate(resolve));await Promise.all(f.channel.router.queues.values());}
async function complete(f,text='完成',id=Math.random().toString()) {
  const prompt=f.channel.router.state.fixedQueue.active?.message.text;
  f.setSnapshot({thread:{status:{type:'idle'}},turns:[{id,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:prompt}]},{type:'agentMessage',id:'reply-'+id,text}]}]});
  await f.channel.poll();
}
const answerCards=f=>f.sent.filter(s=>JSON.parse(s.data.content).header.subtitle.content==='回复');
test('a fixed bot treats commands, selection numbers and natural aliases as literal text for only its bound chat',async()=>{
  const f=channelFixture();await f.channel.start();
  const inputs=['你好，世界','/chats','/assistant 删除项目','/pair pretend','/new 1 | task','1','选择 2','会话列表'];
  for(const text of inputs){await receive(f,f.event(text));await complete(f);}
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>{assert.match(c.args.clientUserMessageId,/^[0-9a-f-]{36}$/);const {clientUserMessageId,...args}=c.args;return args;}),inputs.map(prompt=>({threadId:binding.id,hostId:'local',prompt})));
  assert.ok(f.calls.every(c=>['read_thread','send_message_to_thread'].includes(c.name)));assert.equal(answerCards(f).length,inputs.length);
  assert.deepEqual(f.events()['card.action.trigger']({}),{});
  await receive(f,f.event('保留原始回复'));await complete(f,'原始回复 /chats 中文，标点');
  assert.equal(f.sent.at(-1).data.msg_type,'interactive');assert.equal(JSON.parse(f.sent.at(-1).data.content).body.elements[0].content,'原始回复 /chats 中文，标点');f.channel.stop();
});
test('unapproved senders only request access; rebinding or revocation blocks queued messages and old notifications',async()=>{
  const f=channelFixture();await f.channel.start();f.events()['im.message.receive_v1'](f.event('/pair pretend','stranger'));
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);
  const original=f.event('first request','new-owner','first-request');f.events()['im.message.receive_v1'](original);f.settings.allowedOpenIds.push('new-owner');
  f.events()['im.message.receive_v1'](original);await Promise.all(f.channel.router.queues.values());assert.equal(f.calls.length,0,'Access-request message must never execute after approval');
  f.events()['im.message.receive_v1'](f.event('should not send'));f.settings.thread={...binding,id:'new-target'};await Promise.all(f.channel.router.queues.values());
  assert.equal(f.calls.length,0);await f.channel.poll();assert.equal(f.sent.length,0);f.channel.stop();
});
test('a redelivered message cannot execute again after rebinding the same bot',async()=>{
  const first=channelFixture();await first.channel.start();const event=first.event('original task','owner','same-message');
  first.events()['im.message.receive_v1'](event);await Promise.all(first.channel.router.queues.values());first.channel.stop();
  const next=channelFixture({...binding,id:'different-chat'});await next.channel.start();next.events()['im.message.receive_v1'](event);
  await Promise.all(next.channel.router.queues.values());assert.equal(next.calls.length,0);next.channel.stop();
});
test('group mentions reach the fixed chat as literal text and its answer returns only to the same group',async()=>{
  const f=channelFixture();await f.channel.start();await receive(f,groupEvent(f,'@_user_1 /chats 中文，标点'));
  const {clientUserMessageId,...args}=f.calls.find(c=>c.name==='send_message_to_thread').args;assert.match(clientUserMessageId,/^[0-9a-f-]{36}$/);
  assert.deepEqual(args,{threadId:binding.id,hostId:'local',prompt:'/chats 中文，标点'});assert.equal(f.sent.length,0);
  f.setSnapshot({thread:{status:{type:'idle'}},turns:[{id:'new-turn',status:'completed',items:[{type:'agentMessage',id:'new',text:'群聊回复'}]}]});
  await f.channel.poll();assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.receive_id,'group-chat');assert.equal(f.sent[0].data.msg_type,'interactive');assert.equal(JSON.parse(f.sent[0].data.content).body.elements[0].content,'群聊回复');f.channel.stop();
});
test('ordinary group chatter, @everyone and @another bot do nothing; new members still need local approval',async()=>{
  const f=channelFixture();await f.channel.start();
  for(const event of [groupEvent(f,'你好',{mentions:[]}),groupEvent(f,'@_user_1 task',{bot:'ou_other'}),groupEvent(f,'@_all task',{mentions:[{key:'@_all',id:{open_id:'all'},name:'所有人'}]})])await receive(f,event);
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
  const first=groupEvent(f,'@_user_1 first request',{owner:'new-member',id:'group-access'});await receive(f,first);assert.equal(f.requests.length,1);assert.equal(f.calls.length,0);
  f.settings.allowedOpenIds.push('new-member');await receive(f,first);assert.equal(f.calls.length,0);
  await receive(f,groupEvent(f,'@_user_1 approved task',{owner:'new-member'}));assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.channel.stop();
});
test('a bare mention replies with a local hint once without calling any model',async()=>{
  const f=channelFixture();await f.channel.start();const event=groupEvent(f,'@_user_1');await receive(f,event);await receive(f,event);
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.msg_type,'interactive');assert.match(JSON.stringify(JSON.parse(f.sent[0].data.content)),/写上你的问题/);f.channel.stop();
});
test('private and group requesters share a FIFO for the bound native conversation',async()=>{
  const f=channelFixture();f.settings.allowedOpenIds.push('second-owner');await f.channel.start();
  await receive(f,f.event('private task'));await receive(f,groupEvent(f,'@_user_1 first group task'));await receive(f,groupEvent(f,'@_user_1 second group task',{owner:'second-owner'}));
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['private task']);
  assert.equal(f.channel.router.state.fixedQueue.pending.length,2);
  await complete(f,'私聊答复');await complete(f,'群聊答复 1');await complete(f,'群聊答复 2');
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['private task','first group task','second group task']);
  assert.deepEqual(answerCards(f).map(s=>s.data.receive_id),['private-chat','group-chat','group-chat']);f.channel.stop();
});
test('identity lookup never blocks the event ACK, is shared, and a stopped bot cannot process the delayed event',async()=>{
  let resolveIdentity,count=0;const pending=new Promise(resolve=>resolveIdentity=resolve),f=channelFixture(binding,{identity:()=>{count++;return pending;}});await f.channel.start();
  const event=groupEvent(f,'@_user_1 queued task');assert.deepEqual(f.events()['im.message.receive_v1'](event),{});assert.equal(f.calls.length,0);assert.equal(count,1);
  f.channel.stop();resolveIdentity({code:0,bot:{open_id:'ou_robot'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('identity lookup failure keeps private chat usable and does not accept unverified group mentions',async()=>{
  let count=0;const f=channelFixture(binding,{identity:async()=>{count++;throw new Error('lookup failed');}});await f.channel.start();
  await receive(f,groupEvent(f,'@_user_1 task'));await receive(f,f.event('private task'));assert.equal(count,1);
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['private task']);f.channel.stop();
});
test('platform visibility is explicit, only supported for fixed bots and cannot open a management bot',()=>{
  const first=saveFeishuBot(botInput);assert.equal(first.accessMode,'approved');
  const publicProfile=saveFeishuBot({id:first.id,accessMode:'feishu'});assert.equal(publicProfile.accessMode,'feishu');
  assert.equal(allowsFeishuUser(publicProfile,'new-user'),true);assert.equal(allowsFeishuUser({...publicProfile,mode:'full'},'new-user'),false);
  assert.throws(()=>saveFeishuBot({id:first.id,mode:'full',accessMode:'feishu'}),/逐个授权/);
  assert.equal(saveFeishuBot({id:first.id,mode:'full'}).accessMode,'approved');
});
test('a platform-scoped fixed bot accepts new private senders and mentioned group senders without adding local accounts',async()=>{
  const f=channelFixture(binding,{accessMode:'feishu'});await f.channel.start();
  await receive(f,f.event('/chats','unapproved-private'));await receive(f,groupEvent(f,'@_user_1 你好，群聊',{owner:'unapproved-member'}));
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['/chats']);assert.equal(f.requests.length,0);assert.deepEqual(f.settings.allowedOpenIds,['owner']);
  await complete(f,'公开范围私聊答复');await complete(f,'公开范围群聊答复');
  assert.deepEqual(answerCards(f).map(s=>s.data.receive_id),['private-chat','group-chat']);f.channel.stop();
});
test('closing platform access blocks already queued work and a forged open policy never opens full management',async()=>{
  const f=channelFixture(binding,{accessMode:'feishu'});await f.channel.start();
  f.events()['im.message.receive_v1'](f.event('queued task','not-approved'));
  f.settings.accessMode='approved';await Promise.all(f.channel.router.queues.values());assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);f.channel.stop();
  const full=channelFixture(binding,{mode:'full',accessMode:'feishu'});await full.channel.start();await receive(full,full.event('/projects','not-approved'));
  assert.equal(full.calls.length,0);assert.equal(full.requests.length,1);full.channel.stop();
});
test('a group answer card mentions its actual requester while preserving Markdown and excluding management controls',async()=>{
  const f=channelFixture(binding,{accessMode:'feishu'});await f.channel.start();await receive(f,groupEvent(f,'@_user_1 检查一下',{owner:'ou_requester'}));
  const text='**状态正常**\n- `status:1`，10 秒 → 20 秒\n\n**结论**：没有断线。';
  f.settings.name='新的会话助手';
  f.setSnapshot({thread:{status:{type:'idle'}},turns:[{id:'new',status:'completed',items:[{type:'agentMessage',id:'reply',text}]}]});await f.channel.poll();
  const card=JSON.parse(f.sent[0].data.content);assert.equal(f.sent[0].data.msg_type,'interactive');assert.equal(f.sent[0].data.receive_id,'group-chat');
  assert.equal(card.header.title.content,'新的会话助手');
  assert.equal(card.body.elements[0].content,'回复 <at id=ou_requester></at>');assert.equal(card.body.elements.at(-1).content,text);
  assert.ok(!JSON.stringify(card).includes('behaviors'));assert.ok(!JSON.stringify(card).includes('/chats'));f.channel.stop();
});
test('restart preserves each queued sender and produces separate group answers and an unmentioned private answer',async()=>{
  const f=channelFixture(binding,{accessMode:'feishu'});await f.channel.start();await receive(f,groupEvent(f,'@_user_1 A',{owner:'ou_alice'}));await receive(f,groupEvent(f,'@_user_1 B',{owner:'ou_bob'}));
  await receive(f,f.event('private task','ou_private'));const saved=structuredClone(f.channel.router.state);f.channel.stop();
  const restored=channelFixture(binding,{accessMode:'feishu',state:saved});await restored.channel.start();
  await complete(restored,'给 A 的答复','a');await complete(restored,'给 B 的答复','b');await complete(restored,'私聊答复','c');
  const cards=answerCards(restored).map(s=>JSON.parse(s.data.content));assert.equal(cards.length,3);
  assert.equal(cards[0].body.elements[0].content,'回复 <at id=ou_alice></at>');assert.equal(cards[1].body.elements[0].content,'回复 <at id=ou_bob></at>');
  assert.ok(!JSON.stringify(cards[2]).includes('<at'));
  assert.deepEqual(restored.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args.prompt),['B','private task']);restored.channel.stop();
});
test('revoking the latest requester still allows an earlier authorized participant to receive the group reply',async()=>{
  const f=channelFixture();f.settings.allowedOpenIds.push('ou_alice','ou_bob');await f.channel.start();
  await receive(f,groupEvent(f,'@_user_1 A',{owner:'ou_alice'}));await receive(f,groupEvent(f,'@_user_1 B',{owner:'ou_bob'}));f.settings.allowedOpenIds=f.settings.allowedOpenIds.filter(id=>id!=='ou_bob');
  await complete(f);
  assert.equal(answerCards(f).length,1);assert.equal(JSON.parse(answerCards(f)[0].data.content).body.elements[0].content,'回复 <at id=ou_alice></at>');
  assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.channel.stop();
});
test('a request arriving during a completion read remains queued and gets a distinct answer',async()=>{
  const f=channelFixture(binding,{accessMode:'feishu'});await f.channel.start();await receive(f,groupEvent(f,'@_user_1 A',{owner:'ou_alice'}));
  const original=f.channel.router.desktop.call;let resolveRead;f.channel.router.desktop.call=(...args)=>{f.channel.router.desktop.call=original;return new Promise(resolve=>resolveRead=resolve);};
  const poll=f.channel.poll();await new Promise(resolve=>setImmediate(resolve));
  f.events()['im.message.receive_v1'](groupEvent(f,'@_user_1 B',{owner:'ou_alice'}));
  resolveRead({thread:{status:{type:'idle'}},turns:[{id:'a-completion',status:'completed',items:[{type:'agentMessage',id:'reply',text:'A 的回复'}]}]});
  await poll;assert.equal(answerCards(f).length,1);assert.equal(f.channel.router.state.fixedQueue.active.message.text,'B');
  await complete(f,'B 的回复','b-completion');assert.equal(answerCards(f).length,2);f.channel.stop();
});
test('channel manager applies edits without duplicate consumers and isolates a failed bot from healthy channels',async()=>{
  let bots=[{...botInput,id:'default',enabled:true},{...botInput,id:'another',enabled:true,appId:'cli_other'}],stops=0,starts=0;const statuses=[];
  const manager=new ChannelManager({desktop:{},onStatus:(id,s)=>statuses.push([id,s]),listBots:()=>bots,wechatAccount:()=>({}),
    createFeishu:({settings,onStatus})=>({start:async()=>{starts++;if(settings.id==='another')throw new Error('bad account');onStatus({state:'connected'});},stop:()=>{stops++;},poll:async()=>{}})});
  await Promise.all([manager.reconcile(),manager.reconcile()]);assert.equal(starts,2);assert.equal(manager.channels.size,1);assert.ok(statuses.some(([id,s])=>id==='feishu' && s.state==='connected'));
  bots=[{...bots[0],thread:{...binding,id:'updated'}}];await manager.reconcile();assert.equal(starts,3);assert.equal(stops,2);
  bots[0].enabled=false;await manager.reconcile();assert.equal(manager.channels.size,0);assert.equal(stops,3);await manager.stop();
});
