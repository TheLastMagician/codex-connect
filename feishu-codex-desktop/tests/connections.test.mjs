import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-connections-test-'));
process.env.FEISHU_CODEX_DATA_DIR=folder;
delete process.env.FEISHU_APP_ID;delete process.env.FEISHU_APP_SECRET;
const {readJson,writeJson}=await import('../src/storage.mjs');
const {feishuBots,saveFeishuBot,publicBot,botStateName,rememberFeishuRequest,authorizeFeishuUser,deleteFeishuBot}=await import('../src/connections.mjs');
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
function channelFixture(thread=binding) {
  const settings={...botInput,thread,id:'default',enabled:true,allowedOpenIds:['owner']};const calls=[],sent=[],requests=[];let events;
  const sdk={Client:class {constructor(){this.im={v1:{message:{create:async args=>{sent.push(args);return {code:0};}}}};}},
    WSClient:class {async start({eventDispatcher}){events=eventDispatcher;}close(){}},EventDispatcher:class {register(value){return value;}}};
  let snapshot={thread:{status:{type:'idle'}},turns:[{id:'old-turn',status:'completed',items:[{type:'agentMessage',id:'old',text:'旧回复'}]}]};
  const desktop={call:async(name,args,options)=>{calls.push({name,args});options?.beforeSend?.();if(name==='read_thread')return snapshot;return {};}};
  const channel=createFeishuChannel({desktop,settings,getSettings:()=>settings,sdk,operator:{run:()=>assert.fail('Fixed bot cannot invoke operator')},loadState:()=>({}),save:()=>{},rememberRequest:m=>requests.push(m)});
  const event=(text,owner='owner',id=Math.random().toString())=>({sender:{sender_type:'user',sender_id:{open_id:owner}},message:{message_id:id,chat_id:'private-chat',chat_type:'p2p',message_type:'text',create_time:String(Date.now()),content:JSON.stringify({text})}});
  return {channel,calls,sent,settings,requests,event,events:()=>events,setSnapshot:value=>snapshot=value};
}
test('a fixed bot treats commands, selection numbers and natural aliases as literal text for only its bound chat',async()=>{
  const f=channelFixture();await f.channel.start();
  const inputs=['你好，世界','/chats','/assistant 删除项目','/pair pretend','/new 1 | task','1','选择 2','会话列表'];
  for(const text of inputs){f.events()['im.message.receive_v1'](f.event(text));await Promise.all(f.channel.router.queues.values());}
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args),inputs.map(prompt=>({threadId:binding.id,hostId:'local',prompt})));
  assert.ok(f.calls.every(c=>['read_thread','send_message_to_thread'].includes(c.name)));assert.equal(f.sent.length,0);
  assert.deepEqual(f.events()['card.action.trigger']({}),{});
  f.setSnapshot({thread:{status:{type:'idle'}},turns:[{id:'new-turn',status:'completed',items:[{type:'agentMessage',id:'new',text:'原始回复 /chats 中文，标点'}]}]});
  await f.channel.poll();assert.equal(f.sent[0].data.msg_type,'text');assert.equal(JSON.parse(f.sent[0].data.content).text,'原始回复 /chats 中文，标点');f.channel.stop();
});
test('unapproved senders only request access; rebinding or revocation blocks queued messages and old notifications',async()=>{
  const f=channelFixture();await f.channel.start();f.events()['im.message.receive_v1'](f.event('/pair pretend','stranger'));
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);
  const original=f.event('first request','new-owner','first-request');f.events()['im.message.receive_v1'](original);f.settings.allowedOpenIds.push('new-owner');
  f.events()['im.message.receive_v1'](original);await Promise.all(f.channel.router.queues.values());assert.equal(f.calls.length,0,'Access-request message must never execute after approval');
  let unblock;f.channel.router.queues.set('private-chat',new Promise(resolve=>unblock=resolve));
  f.events()['im.message.receive_v1'](f.event('should not send'));f.settings.thread={...binding,id:'new-target'};unblock();await Promise.all(f.channel.router.queues.values());
  assert.equal(f.calls.length,0);await f.channel.poll();assert.equal(f.sent.length,0);f.channel.stop();
});
test('a redelivered message cannot execute again after rebinding the same bot',async()=>{
  const first=channelFixture();await first.channel.start();const event=first.event('original task','owner','same-message');
  first.events()['im.message.receive_v1'](event);await Promise.all(first.channel.router.queues.values());first.channel.stop();
  const next=channelFixture({...binding,id:'different-chat'});await next.channel.start();next.events()['im.message.receive_v1'](event);
  await Promise.all(next.channel.router.queues.values());assert.equal(next.calls.length,0);next.channel.stop();
});
test('channel manager applies edits without duplicate consumers and isolates a failed bot from healthy channels',async()=>{
  let bots=[{...botInput,id:'default',enabled:true},{...botInput,id:'another',enabled:true,appId:'cli_other'}],stops=0,starts=0;const statuses=[];
  const manager=new ChannelManager({desktop:{},onStatus:(id,s)=>statuses.push([id,s]),listBots:()=>bots,wechatAccount:()=>({}),
    createFeishu:({settings,onStatus})=>({start:async()=>{starts++;if(settings.id==='another')throw new Error('bad account');onStatus({state:'connected'});},stop:()=>{stops++;},poll:async()=>{}})});
  await Promise.all([manager.reconcile(),manager.reconcile()]);assert.equal(starts,2);assert.equal(manager.channels.size,1);assert.ok(statuses.some(([id,s])=>id==='feishu' && s.state==='connected'));
  bots=[{...bots[0],thread:{...binding,id:'updated'}}];await manager.reconcile();assert.equal(starts,3);assert.equal(stops,2);
  bots[0].enabled=false;await manager.reconcile();assert.equal(manager.channels.size,0);assert.equal(stops,3);await manager.stop();
});
