import test from 'node:test';
import assert from 'node:assert/strict';
import {Router,parseMessage} from '../src/router.mjs';

const now=1700000000000;
function event(text,options={}) {
  return {sender:{sender_type:'user',sender_id:{open_id:options.user||'owner'}},
    message:{message_id:options.id||'msg-1',chat_id:options.chat||'chat-1',chat_type:options.chatType||'p2p',
      message_type:'text',create_time:String(options.at??now),content:JSON.stringify({text})}};
}
function fixture(settings={allowedOpenIds:['owner']},state={}) {
  const calls=[];const sent=[];
  const desktop={call:async(name,args)=>{
    calls.push({name,args});
    if(name==='list_threads' && args?.limit>50) throw new Error('limit must be <=50');
    if(name==='list_threads') return {pinnedThreads:[],threads:[
      {id:'a',kind:'codex',title:'会话 A',hostId:'local',status:'idle'},
      {id:'b',kind:'codex',title:'会话 B',hostId:'local',status:'idle'},
      {id:'c',kind:'chatgpt',title:'ChatGPT 会话'}]};
    if(name==='wait_threads') throw new Error('background waits require a live caller turn');
    if(name==='read_thread') return {thread:{status:{type:'notLoaded'}},turns:[{id:'old-turn',status:'completed',items:[{type:'agentMessage',id:'old',text:'旧回复',phase:'final_answer'}]}]};
    if(name==='list_projects') return {projects:[{projectId:'p',projectKind:'local',label:'项目'}]};
    if(name==='create_thread') return {threadId:'new',hostId:'local'};
    if(name==='list_archived_threads') return {threads:[{id:'archived',kind:'codex',title:'已归档'}]};
    return {};
  }};
  const router=new Router({desktop,getConfig:()=>settings,saveConfig:value=>{settings=value;},state,
    saveState:()=>{},send:async(chat,text)=>sent.push({chat,text}),now:()=>now});
  return {router,calls,sent,get settings(){return settings;},state,desktop};
}
async function deliver(f,text,options={}) {
  const accepted=f.router.accept(event(text,options));
  await Promise.all(f.router.queues.values());return accepted;
}
test('unauthorized, group, stale, invalid messages do not execute or reply',async()=>{
  const f=fixture();
  assert.equal(await deliver(f,'任务',{user:'stranger'}),false);
  assert.equal(await deliver(f,'任务',{chatType:'group'}),false);
  assert.equal(await deliver(f,'任务',{at:now-11*60*1000}),false);
  assert.equal(parseMessage({...event('x'),message:{content:'invalid'}}),null);
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('group parsing requires this exact bot mention, removes only its tokens and preserves punctuation and other mentions',()=>{
  const raw=event('@_user_1 检查，@_user_10 的订单。',{chatType:'group'});raw.message.mentions=[
    {key:'@_user_1',id:{open_id:'ou_bot'},name:'Codex'},{key:'@_user_10',id:{open_id:'ou_person'},name:'小张'}];
  assert.equal(parseMessage(raw),null);assert.equal(parseMessage(raw,{botOpenId:'ou_other'}),null);
  const parsed=parseMessage(raw,{botOpenId:'ou_bot'});assert.equal(parsed.text,'检查，@小张 的订单。');assert.equal(parsed.chatType,'group');
  assert.equal(parseMessage({...raw,message:{...raw.message,content:JSON.stringify({text:'@_user_10 only'})}},{botOpenId:'ou_bot'}),null);
  assert.equal(parseMessage({...raw,sender:{...raw.sender,sender_type:'app'}},{botOpenId:'ou_bot'}),null);
  assert.equal(parseMessage({...raw,app_id:'cli_other'},{botOpenId:'ou_bot',appId:'cli_this'}),null);
});
test('group selection stays separate from private selection and pairing codes cannot grant access from a group',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'private-list'});await deliver(f,'/use 1',{id:'private-choice'});
  for(const [id,text] of [['group-list','/chats'],['group-choice','/use 2'],['group-task','群里任务']]) {
    f.router.acceptMessage({openId:'owner',chatId:'group-chat',chatType:'group',id,text,timestamp:now});await Promise.all(f.router.queues.values());
  }
  assert.equal(f.state.sessions['owner:chat-1'].selected.id,'a');assert.equal(f.state.sessions['owner:group-chat'].selected.id,'b');
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.threadId,'b');
  const unpaired=fixture({allowedOpenIds:[],pairing:{code:'secret',expiresAt:now+10000}});
  assert.equal(unpaired.router.acceptMessage({openId:'stranger',chatId:'group-chat',chatType:'group',id:'pair-group',text:'/pair secret',timestamp:now}),false);
  assert.deepEqual(unpaired.settings.allowedOpenIds,[]);assert.equal(unpaired.settings.pairing.code,'secret');assert.equal(unpaired.calls.length,0);
});
test('pairing requires unexpired local secret and is consumed once',async()=>{
  const f=fixture({allowedOpenIds:[],pairing:{code:'secret-code',expiresAt:now+60000}});
  assert.equal(await deliver(f,'/pair wrong'),false);
  assert.equal(await deliver(f,'/pair secret-code',{id:'pair'}),true);
  assert.deepEqual(f.settings.allowedOpenIds,['owner']);assert.equal(f.settings.pairing,undefined);
  assert.equal(await deliver(f,'/pair secret-code',{id:'second',user:'other'}),false);
  const expired=fixture({allowedOpenIds:[],pairing:{code:'secret-code',expiresAt:now-1}});
  assert.equal(await deliver(expired,'/pair secret-code'),false);
});
test('duplicate delivery remains deduplicated after restart',async()=>{
  const f=fixture();await deliver(f,'/chats');
  assert.equal(await deliver(f,'/chats'),false);
  const after=fixture(f.settings,f.state);
  assert.equal(await deliver(after,'/chats'),false);assert.equal(after.calls.length,0);
});
test('chat list respects desktop API bounds and returns selectable chats',async()=>{
  const f=fixture();
  await deliver(f,'/chats',{id:'list-bounded'});
  assert.match(f.sent[0].text,/1\. 会话 A/);
  assert.doesNotMatch(f.sent[0].text,/操作未完成/);
  await deliver(f,'/use 2',{id:'choose-bounded'});
  assert.equal(f.state.sessions['owner:chat-1'].selected.id,'b');
});
test('message routes to chosen real desktop chat and does not change its model',async()=>{
  const f=fixture();
  await deliver(f,'/chats',{id:'list'});await deliver(f,'/use 2',{id:'use'});
  await deliver(f,'修复这个项目',{id:'send'});
  const call=f.calls.find(c=>c.name==='send_message_to_thread');
  assert.deepEqual(call.args,{threadId:'b',hostId:'local',prompt:'修复这个项目'});
  assert.equal(f.state.sessions['owner:chat-1'].threads.length,2);
  assert.equal([...f.router.watches.values()][0].messageId,'old');
  await f.router.poll();
  assert.equal(f.sent.filter(s=>s.text.includes('旧回复')).length,0);
});

test('project lists include chats older than the global recent 50 and page across all 32',async()=>{
  const f=fixture();
  const original=f.desktop.call;
  f.desktop.call=async(name,args)=>name==='list_threads'?{threads:[{id:'older-1',kind:'codex',hostId:'local',projectId:null,title:'近期桌面标题',updatedAt:32}]}:original(name,args);
  f.router.getLocalThreads=async()=>Array.from({length:32},(_,i)=>({id:`older-${i+1}`,title:`历史 ${i+1}`,projectId:'p',kind:'codex',hostId:'local',updatedAt:32-i}));
  await deliver(f,'/projects',{id:'projects-history'});
  await deliver(f,'/project 1',{id:'project-history'});
  assert.equal(f.state.sessions['owner:chat-1'].threads.length,32);
  assert.match(f.sent.at(-1).text,/第 1\/4 页/);
  await deliver(f,'/next',{id:'next-history'});
  assert.match(f.sent.at(-1).text,/11\. 历史 11/);
  await deliver(f,'/page 4',{id:'last-history'});
  assert.match(f.sent.at(-1).text,/31\. 历史 31/);
  await deliver(f,'32',{id:'select-history'});
  assert.equal(f.state.sessions['owner:chat-1'].selected.id,'older-32');
  await deliver(f,'继续',{id:'send-history'});
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.threadId,'older-32');
  assert.ok(!f.calls.some(c=>c.name==='wait_threads'));
});

test('failed historical catalog is visibly partial instead of claiming all results are shown',async()=>{
  const f=fixture();f.router.getLocalThreads=async()=>{throw new Error('unavailable');};
  await deliver(f,'/chats',{id:'partial'});
  assert.match(f.sent.at(-1).text,/历史列表暂时无法读取/);
  assert.doesNotMatch(f.sent.at(-1).text,/已显示全部结果/);
});

test('reply notifications wait for completed text and survive restart without replaying old replies',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'notify-list'});await deliver(f,'/use 1',{id:'notify-select'});
  await deliver(f,'你好',{id:'notify-send'});
  const after=fixture(f.settings,f.state);const original=after.desktop.call;
  let status='inProgress';let text='半截';
  after.desktop.call=async(name,args)=>name==='read_thread'?{thread:{status:{type:'active'}},turns:[{id:'new-turn',status,items:[{type:'agentMessage',id:'new-message',phase:'final_answer',text}]}]}:original(name,args);
  await after.router.poll();assert.equal(after.sent.length,0);
  status='completed';text='完整回复';await after.router.poll();
  assert.equal(after.sent[0].text,'完整回复');assert.equal(after.router.watches.size,0);
  await after.router.poll();assert.equal(after.sent.length,1);
});

test('unknown send outcome is never retried and explains how to check before resending',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'fail-list'});await deliver(f,'/use 1',{id:'fail-select'});
  const original=f.desktop.call;let sends=0;
  f.desktop.call=async(name,args)=>{if(name==='send_message_to_thread'){sends++;throw new Error('transport failed');}return original(name,args);};
  await deliver(f,'任务',{id:'fail-send'});await deliver(f,'任务',{id:'fail-send'});
  assert.equal(sends,1);assert.match(f.sent.at(-1).text,/未确认发送结果/);assert.equal(f.router.watches.size,0);
});

test('a target loading timeout preserves selection and reports no send without starting reply watches',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'unloaded-list'});await deliver(f,'/use 1',{id:'unloaded-select'});
  const original=f.desktop.call;
  f.desktop.call=async(name,args)=>{
    if(name==='send_message_to_thread')throw Object.assign(new Error('已尝试打开目标会话，但加载尚未完成，消息尚未发送。请稍后重试。'),{notSent:true});
    return original(name,args);
  };
  await deliver(f,'任务',{id:'unloaded-send'});
  assert.match(f.sent.at(-1).text,/加载尚未完成，消息尚未发送/);
  assert.doesNotMatch(f.sent.at(-1).text,/任务已发送|未确认发送结果/);
  assert.equal(f.router.watches.size,0);
  assert.equal(f.calls.some(c=>c.name==='navigate_to_codex_page'),false);
  assert.equal(f.state.sessions['owner:chat-1'].selected.id,'a');
});
test('different paired people cannot change each others selected chats',async()=>{
  const f=fixture({allowedOpenIds:['owner','other']});
  await deliver(f,'/chats',{id:'one'});await deliver(f,'/use 1',{id:'two'});
  await deliver(f,'/chats',{id:'three',user:'other',chat:'chat-2'});
  await deliver(f,'/use 2',{id:'four',user:'other',chat:'chat-2'});
  await deliver(f,'任务',{id:'five'});
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.threadId,'a');
});
test('new task uses project returned by desktop and is selected',async()=>{
  const f=fixture();await deliver(f,'/projects',{id:'p'});await deliver(f,'/new 1 | 构建项目',{id:'n'});
  assert.deepEqual(f.calls.find(c=>c.name==='create_thread').args,
    {prompt:'构建项目',target:{type:'project',projectId:'p',environment:{type:'local'}}});
  assert.equal(f.state.sessions['owner:chat-1'].selected.id,'new');
});
test('unsupported actions never silently fall back to shell execution or messages',async()=>{
  const f=fixture();await deliver(f,'/stop',{id:'s'});await deliver(f,'/approve',{id:'a'});
  assert.equal(f.calls.length,0);assert.match(f.sent[0].text,/不能/);
});
test('slash task can be explicitly sent and exact duplicate titles are rejected',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'l'});await deliver(f,'/use 会话 A',{id:'u'});
  await deliver(f,'/send /command task',{id:'s'});
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.prompt,'/command task');
  assert.throws(()=>f.router.choose({threads:[{id:'1',title:'同名'},{id:'2',title:'同名'}]},'同名'),/重复/);
});
test('archived list numbering matches selection snapshot',async()=>{
  const f=fixture();await deliver(f,'/archived',{id:'l'});await deliver(f,'/use 1',{id:'u'});
  assert.match(f.sent[0].text,/1\. 已归档/);assert.equal(f.state.sessions['owner:chat-1'].selected.id,'archived');
});
test('chat pagination preserves global numbers and selecting a number stops intercepting numeric tasks',async()=>{
  const f=fixture();const original=f.desktop.call;
  f.desktop.call=async(name,args)=>name==='list_threads'?{threads:Array.from({length:25},(_,i)=>({id:`chat-${i+1}`,kind:'codex',title:`会话 ${i+1}`,status:'idle'}))}:original(name,args);
  await deliver(f,'/chats',{id:'p1'});assert.match(f.sent.at(-1).text,/第 1\/3 页/);assert.doesNotMatch(f.sent.at(-1).text,/11\. 会话/);
  assert.match(f.sent.at(-1).text,/\/next 下一页/);
  await deliver(f,'/next',{id:'p2'});assert.match(f.sent.at(-1).text,/第 2\/3 页/);assert.match(f.sent.at(-1).text,/11\. 会话 11/);
  assert.match(f.sent.at(-1).text,/\/use 11/);
  await deliver(f,'12',{id:'pick'});assert.equal(f.state.sessions['owner:chat-1'].selected.id,'chat-12');
  await deliver(f,'42',{id:'numeric-task'});
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.prompt,'42');
  await deliver(f,'/page 3',{id:'jump'});assert.match(f.sent.at(-1).text,/21\. 会话 21/);
  await deliver(f,'/next',{id:'end'});assert.match(f.sent.at(-1).text,/最后一页/);
  assert.equal(f.state.sessions['owner:chat-1'].view.page,3);
  await deliver(f,'/prev',{id:'back'});assert.match(f.sent.at(-1).text,/11\. 会话 11/);
});
test('project list explains actions, paginates, and a project number filters its real chats',async()=>{
  const f=fixture();const original=f.desktop.call;
  f.desktop.call=async(name,args)=>{
    if(name==='list_projects') return {projects:Array.from({length:15},(_,i)=>({projectId:`p${i+1}`,projectKind:'local',label:`项目 ${i+1}`}))};
    if(name==='list_threads') return {threads:[{id:'a',kind:'codex',title:'属于项目12',projectId:'p12'},{id:'b',kind:'codex',title:'其他项目',projectId:'p1'}]};
    return original(name,args);
  };
  await deliver(f,'/projects',{id:'projects'});assert.match(f.sent.at(-1).text,/\/project 1/);assert.match(f.sent.at(-1).text,/\/new 1 \|/);
  await deliver(f,'/next',{id:'next'});assert.match(f.sent.at(-1).text,/11\. 项目 11/);
  await deliver(f,'/use 12',{id:'wrong-kind'});assert.match(f.sent.at(-1).text,/你看到的是项目编号/);
  await deliver(f,'12',{id:'project-pick'});assert.match(f.sent.at(-1).text,/项目 12 · 会话/);
  assert.match(f.sent.at(-1).text,/属于项目12/);assert.doesNotMatch(f.sent.at(-1).text,/其他项目/);
  await deliver(f,'1',{id:'chat-pick'});assert.equal(f.state.sessions['owner:chat-1'].selected.id,'a');
});
test('archived pages use the server cursor, reuse loaded pages and do not restart at the end',async()=>{
  const f=fixture();const cursors=[];const original=f.desktop.call;
  f.desktop.call=async(name,args)=>{
    if(name!=='list_archived_threads') return original(name,args);
    cursors.push(args.cursor||null);
    const second=!!args.cursor;return {threads:Array.from({length:second?2:10},(_,i)=>({id:`arch-${second?i+11:i+1}`,kind:'codex',title:`归档 ${second?i+11:i+1}`})),nextCursor:second?null:'page-two'};
  };
  await deliver(f,'/archived',{id:'first'});assert.match(f.sent.at(-1).text,/后面还有/);
  await deliver(f,'/more',{id:'second'});assert.match(f.sent.at(-1).text,/11\. 归档 11/);assert.match(f.sent.at(-1).text,/\/unarchive/);
  await deliver(f,'/prev',{id:'prev'});await deliver(f,'/next',{id:'cached'});
  await deliver(f,'/next',{id:'end'});assert.match(f.sent.at(-1).text,/最后一页/);
  assert.deepEqual(cursors,[null,'page-two']);
  await deliver(f,'11',{id:'pick'});assert.equal(f.state.sessions['owner:chat-1'].selected.archived,true);
  await deliver(f,'任务',{id:'still-archived'});assert.match(f.sent.at(-1).text,/先发送 \/unarchive/);
  assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,0);
  await deliver(f,'/unarchive',{id:'restore'});await deliver(f,'任务',{id:'task'});
  assert.equal(f.calls.find(c=>c.name==='send_message_to_thread').args.threadId,'arch-11');
});
test('empty results and page errors give valid next steps and never change selection',async()=>{
  const f=fixture();await deliver(f,'/page 2',{id:'no-list'});assert.match(f.sent.at(-1).text,/先发送 \/chats/);
  await deliver(f,'/chats 不存在',{id:'empty'});assert.match(f.sent.at(-1).text,/没有匹配/);assert.match(f.sent.at(-1).text,/\/chats 关键词/);
  await deliver(f,'/page -1',{id:'bad-page'});assert.match(f.sent.at(-1).text,/跳页示例/);
  assert.equal(f.state.sessions['owner:chat-1'].selected,undefined);
});
test('a reply target remains selectable by ID after filtering another list',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'list'});await deliver(f,'/use 1',{id:'select'});
  await deliver(f,'任务',{id:'task'});await deliver(f,'/chats 会话 B',{id:'filter'});
  await deliver(f,'/use a',{id:'reply-target'});assert.equal(f.state.sessions['owner:chat-1'].selected.id,'a');
});
test('card selection stays bound to actual chat after list numbering changes',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'initial'});
  await deliver(f,'/chats 会话 B',{id:'filtered'});
  assert.equal(f.router.acceptCard({openId:'owner',chatId:'chat-1',id:'card-select',updateMessageId:'card-message',
    action:{kind:'select',thread:{id:'a',title:'会话 A',hostId:'local'}}}),true);
  await Promise.all(f.router.queues.values());assert.equal(f.state.sessions['owner:chat-1'].selected.id,'a');
  assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,0);
});
test('stale page cards explain refresh and cannot paginate a different list',async()=>{
  const f=fixture();await deliver(f,'/chats',{id:'initial'});const oldView=f.state.sessions['owner:chat-1'].view.id;
  await deliver(f,'/projects',{id:'project-list'});
  f.router.acceptCard({openId:'owner',chatId:'chat-1',id:'stale-page',updateMessageId:'card-message',action:{kind:'page',viewId:oldView,page:2}});
  await Promise.all(f.router.queues.values());assert.match(f.sent.at(-1).text,/列表已经更新/);
  assert.equal(f.state.sessions['owner:chat-1'].view.kind,'projects');
});
