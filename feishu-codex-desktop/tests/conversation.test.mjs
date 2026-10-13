import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationMessages,renderConversation} from '../src/conversation.mjs';
import {Router} from '../src/router.mjs';
import {replyCard} from '../src/cards.mjs';
import {createSender} from '../src/outbound.mjs';

const result={thread:{title:'演示会话',status:{type:'idle'}},turns:[
  {id:'new',items:[{type:'userMessage',content:[{type:'text',text:'第二个问题'}]},
    {type:'reasoning',summary:'内部推理不可显示'},
    {type:'commandExecution',command:'内部命令不可显示'},
    {type:'agentMessage',phase:'commentary',text:'正在检查'},
    {type:'agentMessage',phase:'final_answer',text:'**第二个回答**\n```js\nconst n = 2;\n```'}]},
  {id:'old',items:[{type:'userMessage',content:[{type:'text',text:'第一个问题'}]},
    {type:'agentMessage',phase:'final_answer',text:'第一个回答'}]}
]};
const conversation={messages:conversationMessages(result),turnCount:2};
const session={openId:'owner',chatId:'chat',selected:{id:'thread',hostId:'local',title:'演示会话'}};

test('recent context includes user input and visible replies in chronological order',()=>{
  assert.deepEqual(conversation.messages.map(m=>m.text),[
    '第一个问题','第一个回答','第二个问题','正在检查','**第二个回答**\n```js\nconst n = 2;\n```']);
  const text=renderConversation(conversation.messages);
  assert.match(text,/你 · 消息 1/);assert.match(text,/Codex · 进度 · 消息 4/);
  assert.equal(text.split('──────────').length,5);
  assert.doesNotMatch(text,/内部推理|内部命令/);
});

test('attachments, empty context and failures remain explicit without exposing tool data',()=>{
  const messages=conversationMessages({turns:[{items:[{type:'userMessage',content:[
    {type:'text',text:'看看附件'},{type:'image',url:'private-url'}]}],error:{message:'执行失败'}}]});
  assert.equal(messages[0].text,'看看附件\n[附件]');assert.equal(messages[1].role,'error');
  assert.doesNotMatch(renderConversation(messages),/private-url/);
  assert.equal(renderConversation([]),'暂无可显示的对话消息。');
});

test('read is a read-only recent conversation while status omits message content',async()=>{
  const calls=[];const replies=[];
  const router=new Router({desktop:{call:async(name,args)=>{calls.push({name,args});return result;}},
    getConfig:()=>({allowedOpenIds:['owner']}),state:{sessions:{'owner:chat':session}},saveState:()=>{},
    send:async(_chat,text,meta)=>replies.push({text,meta})});
  await router.handle({openId:'owner',chatId:'chat',text:'/read'});
  assert.equal(replies[0].meta.kind,'conversation');assert.equal(replies[0].meta.title,'最近对话');
  assert.deepEqual(replies[0].meta.conversation,conversation);assert.match(replies[0].text,/第一个问题/);
  assert.equal(calls[0].name,'read_thread');assert.equal(calls[0].args.turnLimit,3);assert.equal(calls[0].args.includeOutputs,true);
  await router.handle({openId:'owner',chatId:'chat',text:'/status'});
  assert.equal(replies[1].meta.kind,'info');assert.doesNotMatch(replies[1].text,/第一个问题|第一个回答/);
  assert.equal(calls[1].args.includeOutputs,false);
  assert.ok(calls.every(call=>call.name==='read_thread'));
});

test('forwarded phone prompts appear as user messages while tool results and routing metadata stay hidden',()=>{
  const input='检查 A < B & C，保留 <input>原文</input>';
  const delegation={type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',
    output:{text:`<codex_delegation>\n<source_thread_id>private-id</source_thread_id>\n<input>${input}</input>\n</codex_delegation>`,truncated:false}};
  const messages=conversationMessages({turns:[{items:[delegation,
    {type:'commandExecution',output:{text:'内部命令输出'}},{...delegation,output:{text:'工具输出不可显示'}},
    {type:'agentMessage',text:'收到任务'}]}]});
  assert.deepEqual(messages.map(m=>m.text),[input,'收到任务']);assert.equal(messages[0].role,'user');
  assert.doesNotMatch(renderConversation(messages),/private-id|内部命令输出|工具输出不可显示/);
  assert.equal(conversationMessages({turns:[{items:[{...delegation,namespace:'other'}]}]}).length,0);
  assert.equal(conversationMessages({turns:[{items:[{...delegation,name:'other'}]}]}).length,0);
  assert.equal(conversationMessages({turns:[{items:[delegation,{type:'userMessage',content:[{type:'text',text:input}]}]}]}).length,1);
});

test('a truncated forwarded prompt is labelled instead of silently disappearing',()=>{
  const messages=conversationMessages({turns:[{items:[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',
    output:{text:'<codex_delegation>\n<source_thread_id>private-id</source_thread_id>\n<input>手机上的长任务',truncated:true}}]}]});
  assert.equal(messages.length,1);assert.match(messages[0].text,/手机上的长任务/);assert.match(messages[0].text,/已截断/);
  assert.doesNotMatch(messages[0].text,/private-id/);
});

test('conversation cards use distinct role blocks and separators and preserve reply Markdown',()=>{
  const card=replyCard('unused',{kind:'conversation',conversation,session},()=> 'token');
  assert.equal(card.header.title.content,'最近对话');assert.match(card.header.subtitle.content,/最近 2 轮 · 从旧到新/);
  const elements=card.body.elements;
  const headers=elements.filter(e=>e.tag==='markdown' && /消息 \d/.test(e.content));
  assert.equal(headers.length,5);assert.match(headers[0].content,/你/);assert.match(headers[1].content,/Codex/);
  assert.equal(elements.filter(e=>e.tag==='hr').length,5);
  assert.ok(elements.some(e=>e.content===conversation.messages[4].text));
  assert.ok(JSON.stringify(card).includes('查看对话'));assert.ok(!JSON.stringify(card).includes('unused'));
});

function senderFixture() {
  const cards=[];const methods=[];let issued=0;
  const message={create:async args=>{methods.push('create');cards.push(JSON.parse(args.data.content));return {code:0,data:{message_id:'created'}};},
    patch:async args=>{methods.push('patch');cards.push(JSON.parse(args.data.content));return {code:0};}};
  const send=createSender({client:{im:{v1:{message}}},state:{sessions:{s:session}},saveState:()=>{},
    getConfig:()=>({cardActionsEnabled:true}),actions:{issue:()=>String(++issued),bind:()=>{}}});
  return {send,cards,methods};
}

test('short context updates the clicked card and keeps all message boundaries',async()=>{
  const f=senderFixture();
  await f.send('chat','ignored',{kind:'conversation',conversation,session,updateMessageId:'original'});
  assert.deepEqual(f.methods,['patch']);assert.equal(f.cards.length,1);
  assert.ok(JSON.stringify(f.cards[0]).includes('第一个问题'));assert.ok(JSON.stringify(f.cards[0]).includes('第二个问题'));
});

test('long context retains roles, continuation labels, Unicode, code fences and newest content across cards',async()=>{
  const f=senderFixture();const code='```js\n'+('const emoji = "😀";\n'.repeat(400))+'```';
  await f.send('chat','ignored',{kind:'conversation',session,updateMessageId:'original',conversation:{turnCount:1,messages:[
    {role:'user',text:'检查下面的代码'},{role:'assistant',text:code},{role:'user',text:'最后的问题'}]}});
  assert.ok(f.cards.length>1);assert.ok(f.methods.every(method=>method==='create'));
  const bodies=f.cards.flatMap(card=>card.body.elements.filter(e=>e.tag==='markdown').map(e=>e.content));
  assert.equal(bodies.join('\n').match(/const emoji/g).length,400);
  assert.ok(bodies.some(text=>text.includes('Codex · 消息 2（续）')));
  assert.ok(bodies.some(text=>text.includes('你 · 消息 3')));
  for(const body of bodies.filter(text=>text.includes('const emoji'))) {
    assert.equal((body.match(/^```/gm)||[]).length%2,0);assert.ok(!body.includes('\uFFFD'));
  }
  assert.ok(f.cards.slice(0,-1).every(card=>!JSON.stringify(card).includes('bridgeAction')));
  assert.ok(JSON.stringify(f.cards.at(-1)).includes('bridgeAction'));
});

test('large histories explicitly report omissions and retain the newest question and answer',async()=>{
  const f=senderFixture();
  const messages=Array.from({length:205},(_,i)=>({role:i%2?'assistant':'user',text:`历史消息 ${i+1}`}));
  messages.push({role:'user',text:'最新提问'},{role:'assistant',text:'最新回答'});
  await f.send('chat','ignored',{kind:'conversation',session,conversation:{turnCount:3,messages}});
  assert.equal(f.cards.length,20);assert.match(JSON.stringify(f.cards[0]),/已省略部分较早内容/);
  assert.match(JSON.stringify(f.cards.at(-1)),/最新提问/);assert.match(JSON.stringify(f.cards.at(-1)),/最新回答/);
});
