import test from 'node:test';
import assert from 'node:assert/strict';
import {FixedChatRouter} from '../src/fixed-router.mjs';

const turn=(id,prompt,status='completed',text='答复 '+prompt)=>({id,status,items:[
  {type:'userMessage',content:[{type:'text',text:prompt}]},{type:'agentMessage',id:'reply-'+id,text,phase:'final_answer'}]});
const snapshot=(...turns)=>({thread:{status:{type:'idle'}},turns});
function fixture({state={},desktop,threadId='bound'}={}) {
  const f={sent:[],writes:[],saved:[],state,time:Date.now(),allowed:new Set(['alice','bob','carol']),live:true,snapshot:snapshot(turn('old','old'))};
  f.desktop=desktop||{call:async(name,args,options)=>{
    if(name==='read_thread'){if(f.readError)throw f.readError;return f.snapshot;}
    options?.beforeSend?.();await f.beforeSubmit?.();
    try {await options?.beforeSubmit?.();options?.beforeSend?.();}catch(error){throw Object.assign(error,{notSent:true});}
    f.writes.push(args.prompt);if(f.writeError)throw f.writeError;return f.receipt||{accepted:true};
  }};
  f.router=new FixedChatRouter({thread:{id:threadId,hostId:'local'},desktop:f.desktop,state,saveState:()=>f.saved.push(structuredClone(state)),
    isActive:()=>f.live,isAuthorized:id=>f.allowed.has(id),getConfig:()=>({}),now:()=>f.time,
    send:async(chatId,text,meta)=>{if(f.sendError)throw f.sendError;f.sent.push({chatId,text,meta});}});
  f.message=(text,owner='alice',chatId='group',id=Math.random().toString())=>({id,text,openId:owner,chatId,chatType:chatId==='private'?undefined:'group',timestamp:f.time});
  f.accept=(...messages)=>{for(const m of messages)assert.equal(f.router.acceptMessage(m),true);return f.router.poll();};
  f.complete=async(id,prompt,status='completed')=>{f.snapshot=snapshot(turn(id,prompt,status));await f.router.poll();};
  f.answers=()=>f.sent.filter(s=>s.meta.kind==='assistant');return f;
}

test('simultaneous senders wait for separate native turn completions, never ACKs or progress',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'),f.message('C','carol'));
  assert.deepEqual(f.writes,['A']);assert.ok(f.saved.some(s=>s.fixedQueue.pending.length===3 && Object.keys(s.seen).length===3));
  f.snapshot={thread:{status:{type:'active'}},turns:[turn('a','A','inProgress')]};
  await Promise.all([f.router.poll(),f.router.poll(),f.router.poll()]);assert.deepEqual(f.writes,['A']);assert.equal(f.answers().length,0);
  await f.complete('a','A');assert.deepEqual(f.writes,['A','B']);
  await f.complete('b','B');assert.deepEqual(f.writes,['A','B','C']);await f.complete('c','C');
  assert.deepEqual(f.answers().map(a=>[a.text,a.meta.replyOpenIds]),[['答复 A',['alice']],['答复 B',['bob']],['答复 C',['carol']]]);
  assert.equal(f.state.fixedQueue.active,null);assert.equal(f.state.fixedQueue.pending.length,0);
});

test('the same sender and requests in different groups or private chats keep separate FIFO entries',async()=>{
  const f=fixture();await f.accept(f.message('A','alice','group1'),f.message('B','alice','group2'),f.message('C','bob','private'));
  await f.complete('a','A');await f.complete('b','B');await f.complete('c','C');
  assert.deepEqual(f.answers().map(a=>a.chatId),['group1','group2','private']);assert.equal(f.answers()[2].meta.replyOpenIds,undefined);
});

test('an already busy desktop turn and approval never receive queued input as steering',async()=>{
  const f=fixture();f.snapshot={thread:{status:{type:'active'}},turns:[turn('local','local task','inProgress')]};
  await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);assert.match(f.sent[0].text,/已排队/);
  f.snapshot.thread.status.type='needsAttention';await f.router.poll();assert.deepEqual(f.writes,[]);
  f.snapshot=snapshot(turn('local','local task'));await f.router.poll();assert.deepEqual(f.writes,['A']);assert.equal(f.answers().length,0);
});

test('approval, read failures and unrelated new turns cannot release an active request',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'));
  f.snapshot={thread:{status:{type:'needsAttention'}},turns:[turn('a','A','inProgress')]};await f.router.poll();await f.router.poll();
  assert.equal(f.sent.filter(s=>/审批/.test(s.text)).length,1);assert.deepEqual(f.writes,['A']);
  f.readError=Error('offline');await f.router.poll();assert.deepEqual(f.writes,['A']);delete f.readError;
  f.snapshot=snapshot(turn('unrelated','local input'));await f.router.poll();assert.deepEqual(f.writes,['A']);assert.equal(f.answers().length,0);
  f.snapshot=snapshot(turn('unrelated','local input'),turn('a','A'));await f.router.poll();assert.deepEqual(f.writes,['A','B']);
});

test('failed and interrupted turns notify their requester, then advance the next request',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'),f.message('C','carol'));
  await f.complete('a','A','failed');assert.deepEqual(f.writes,['A','B']);
  await f.complete('b','B','interrupted');assert.deepEqual(f.writes,['A','B','C']);
  assert.deepEqual(f.sent.filter(s=>/执行失败|已中断/.test(s.text)).map(s=>s.meta.openId),['alice','bob']);
});

test('restart preserves queued input and deduplication without repeating the already accepted write',async()=>{
  const first=fixture();const a=first.message('A');await first.accept(a,first.message('B','bob'));
  const state=structuredClone(first.state);first.router.stop();const f=fixture({state});
  assert.equal(f.router.acceptMessage(a),false);await f.router.poll();assert.deepEqual(f.writes,[]);
  await f.complete('a','A');assert.deepEqual(f.writes,['B']);assert.equal(f.answers()[0].meta.openId,'alice');
});

test('a crash during a write or unknown delivery pauses the queue until actual matching input is observed',async()=>{
  const first=fixture();first.writeError=Error('timeout');await first.accept(first.message('A'),first.message('B','bob'));
  assert.equal(first.state.fixedQueue.active.phase,'uncertain');await first.router.poll();assert.deepEqual(first.writes,['A']);
  const state=structuredClone(first.state);state.fixedQueue.active.phase='sending';first.router.stop();const f=fixture({state});
  f.snapshot=snapshot(turn('unrelated','someone else'));await f.router.poll();assert.deepEqual(f.writes,[]);
  await f.complete('a','A');assert.deepEqual(f.writes,['B']);assert.equal(f.answers().length,1);
});

test('definitely unsent messages survive connection errors and automatically retry after recovery',async()=>{
  const f=fixture();f.readError=Error('offline');await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);
  delete f.readError;f.writeError=Object.assign(Error('not loaded'),{notSent:true});await f.router.poll();
  assert.equal(f.state.fixedQueue.active,null);assert.equal(f.state.fixedQueue.pending[0].text,'A');
  delete f.writeError;await f.router.poll();assert.deepEqual(f.writes,['A','A']);await f.complete('a','A');assert.equal(f.answers().length,1);
});

test('queued image input is prepared only at dispatch and a failed download never submits text alone',async()=>{
  const f=fixture();let downloads=0;f.router.prepareInput=async(message)=>{downloads++;assert.deepEqual(message.images,[{key:'img_one'}]);throw Object.assign(Error('图片下载失败，已保留'),{code:'IMAGE_INPUT_ERROR',notSent:true});};
  f.snapshot={thread:{status:{type:'active'}},turns:[turn('busy','local','inProgress')]};
  await f.accept({...f.message('看图'),images:[{key:'img_one'}]});assert.equal(downloads,0);assert.deepEqual(f.writes,[]);
  f.snapshot=snapshot(turn('busy','local'));await f.router.poll();assert.equal(downloads,1);assert.deepEqual(f.writes,[]);
  assert.equal(f.state.fixedQueue.pending[0].images[0].key,'img_one');assert.equal(f.state.fixedQueue.blockedReason,'image');
  assert.ok(f.sent.some(s=>s.text.includes('图片下载失败')));
  const calls=[];const original=f.desktop.call;f.desktop.call=async(name,args,options)=>{if(name==='send_message_to_thread')calls.push(args);return original(name,args,options);};
  f.router.prepareInput=async()=>['prepared-photo.png'];await f.router.poll();assert.deepEqual(calls[0].images,['prepared-photo.png']);assert.deepEqual(f.writes,['看图']);
});

test('an oversized image is retained as rejected input without blocking later text tasks',async()=>{
  const f=fixture();f.router.prepareInput=async()=>{throw Object.assign(Error('图片超过大小限制，本条未发送。'),{notSent:true,code:'IMAGE_INPUT_ERROR',retryable:false});};
  await f.accept({...f.message('看图'),images:[{key:'img_one'}]},f.message('后面的文字'));
  assert.equal(f.state.fixedQueue.rejectedInputs.length,1);assert.deepEqual(f.writes,[]);
  await f.router.poll();assert.deepEqual(f.writes,['后面的文字']);
});

test('an unavailable renderer wakes once per saved batch and submits queued input only after a successful read',async()=>{
  const f=fixture();f.readError=Error('renderer unavailable');let wakes=0;
  f.desktop.recoverForThread=async(thread,options)=>{
    options.authorize();if(!options.beforeWake())return false;wakes++;return true;
  };
  await f.accept(f.message('A'));await f.router.poll();
  assert.equal(wakes,1);assert.equal(f.state.fixedQueue.desktopWakeAttempted,true);assert.deepEqual(f.writes,[]);
  const saved=structuredClone(f.state);f.router.stop();const restored=fixture({state:saved});restored.readError=Error('still asleep');
  restored.desktop.recoverForThread=()=>assert.fail('Restart must retain the wake decision');
  await restored.router.poll();assert.deepEqual(restored.writes,[]);
  delete restored.readError;await restored.router.poll();assert.deepEqual(restored.writes,['A']);
  await restored.complete('a','A');assert.equal(restored.answers().length,1);
});

test('waking during reply recovery returns the original answer without submitting it again',async()=>{
  const f=fixture();await f.accept(f.message('A'));await f.accept(f.message('B','bob'));
  f.readError=Error('renderer unavailable');let wakes=0;
  f.desktop.recoverForThread=async(thread,options)=>{
    options.authorize();assert.equal(options.beforeWake(),true);wakes++;
    delete f.readError;f.snapshot=snapshot(turn('a','A'));return true;
  };
  await f.router.poll();assert.equal(wakes,1);assert.deepEqual(f.writes,['A','B']);assert.equal(f.answers()[0].text,'答复 A');
});

test('revocation during wake recovery never submits the saved message',async()=>{
  const f=fixture();f.readError=Error('renderer unavailable');
  f.desktop.recoverForThread=async(thread,options)=>{f.allowed.clear();options.authorize();assert.fail('Authorization must stop recovery');};
  await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);assert.equal(f.state.fixedQueue.desktopWakeAttempted,undefined);
});

test('reply delivery failure saves an independent outbox and allows the next task to run',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'));f.sendError=Error('Feishu offline');await f.complete('a','A');
  await f.router.deliveryWork;
  assert.deepEqual(f.writes,['A','B']);assert.equal(f.state.fixedQueue.deliveries[0].reply.text,'答复 A');
  const state=structuredClone(f.state);f.router.stop();const restored=fixture({state});restored.snapshot=f.snapshot;
  restored.time=f.time+5001;await restored.router.poll();await restored.router.deliveryWork;
  assert.deepEqual(restored.writes,[]);assert.equal(restored.answers()[0].text,'答复 A');
  assert.equal(restored.state.fixedQueue.deliveries.length,0);
});

test('revocation drops queued work but keeps the active turn barrier until the desktop finishes',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'),f.message('C','carol'));f.allowed.delete('alice');f.allowed.delete('bob');
  await f.router.poll();assert.deepEqual(f.writes,['A']);await f.complete('a','A');assert.deepEqual(f.writes,['A','C']);assert.equal(f.answers().length,0);
});

test('a hanging reply transport cannot block execution, and a saved legacy reply migrates without a native resend',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B'));
  let release;const slow=new Promise(resolve=>{release=resolve;});
  const original=f.router.reply.bind(f.router);f.router.reply=async(...args)=>{await slow;return original(...args);};
  await f.complete('a','A');assert.deepEqual(f.writes,['A','B']);assert.equal(f.state.fixedQueue.deliveries.length,1);
  release();await f.router.deliveryWork;assert.equal(f.state.fixedQueue.deliveries.length,0);
  const legacy=fixture({state:{fixedQueue:{pending:[],active:{message:f.message('old'),phase:'waiting',clientUserMessageId:'legacy',reply:{id:'answer',kind:'assistant',text:'旧回复'}}}}});
  legacy.readError=Error('desktop offline');await legacy.router.poll();await legacy.router.deliveryWork;
  assert.deepEqual(legacy.writes,[]);assert.equal(legacy.answers()[0].text,'旧回复');assert.equal(legacy.state.fixedQueue.active,null);
});

test('stopping or rebinding during a baseline read prevents the native write',async()=>{
  for(const stop of [f=>f.router.stop(),f=>f.live=false]) {
    const f=fixture();let resolve;f.desktop.call=()=>new Promise(r=>resolve=r);
    const work=f.accept(f.message('A'));await new Promise(r=>setImmediate(r));stop(f);resolve(snapshot(turn('old','old')));await work;
    assert.equal(f.state.fixedQueue.active,null);assert.equal(f.state.fixedQueue.pending.length,1);
  }
});

test('two fixed bots bound to the same desktop conversation cannot dispatch overlapping turns',async()=>{
  const first=fixture(),second=fixture({desktop:first.desktop});await first.accept(first.message('A'));await second.accept(second.message('B','bob'));
  assert.deepEqual(first.writes,['A']);await first.complete('a','A');await second.router.poll();assert.deepEqual(first.writes,['A','B']);
});

test('queue overflow is explicit and SDK redelivery never enqueues twice',async()=>{
  const f=fixture();f.snapshot={thread:{status:{type:'active'}},turns:[turn('old','old','inProgress')]};
  const messages=Array.from({length:100},(_,i)=>f.message('task '+i));await f.accept(...messages);
  assert.equal(f.router.acceptMessage(messages[0]),false);assert.equal(f.router.acceptMessage(f.message('overflow')),false);
  assert.equal(f.state.fixedQueue.pending.length,100);assert.ok(f.sent.some(s=>/队列已满/.test(s.text)));assert.deepEqual(f.writes,[]);
});

test('upgrading drains legacy reply watches before dispatching newly queued requests',async()=>{
  const state={watches:{legacy:{thread:{id:'bound',hostId:'local'},openId:'alice',chatId:'group',chatType:'group',replyOpenIds:['alice'],baselineTurnId:'old',messageId:'reply-old'}}};
  const f=fixture({state});f.snapshot={thread:{status:{type:'active'}},turns:[turn('legacy','legacy input','inProgress')]};
  await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);await f.complete('legacy','legacy input');assert.deepEqual(f.writes,['A']);
  assert.equal(f.answers()[0].text,'答复 legacy input');assert.equal(f.router.watches.size,0);
});

test('upgrading clears an already answered legacy watch that steered into its baseline turn',async()=>{
  const state={watches:{legacy:{thread:{id:'bound',hostId:'local'},openId:'alice',chatId:'group',baselineTurnId:'old',messageId:'reply-old'}}};
  const f=fixture({state});await f.accept(f.message('A'));assert.deepEqual(f.writes,['A']);assert.equal(f.router.watches.size,0);assert.equal(f.answers().length,0);
});

test('local steering in the same native turn does not hide the queued request from completion tracking',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'));
  const a=turn('a','A');a.items.splice(1,0,{type:'userMessage',content:[{type:'text',text:'local follow-up'}]});
  f.snapshot=snapshot(a);await f.router.poll();assert.deepEqual(f.writes,['A','B']);assert.equal(f.answers().length,1);
});

test('unmatched unknown delivery with a consistently idle desktop leaves the queue without replaying its original input',async()=>{
  const f=fixture();f.writeError=Error('timeout');await f.accept(f.message('A'),f.message('B','bob'));delete f.writeError;
  f.snapshot=snapshot(turn('local','unrelated desktop task'));f.time+=120001;await f.router.poll();assert.deepEqual(f.writes,['A']);
  f.time+=15001;await f.router.poll();assert.deepEqual(f.writes,['A','B']);
  assert.equal(f.state.fixedQueue.review[0].message.text,'A');assert.equal(f.state.fixedQueue.active.message.text,'B');
  assert.equal(f.answers().length,0,'An unrelated completed task must not become A’s answer');assert.ok(f.sent.some(s=>/原文已保留/.test(s.text)));
});

test('active work, approval and failed reads never count as stable idle observations',async()=>{
  for(const kind of ['active','needsAttention','read-failure']) {
    const f=fixture();f.writeError=Error('timeout');await f.accept(f.message('A'),f.message('B','bob'));delete f.writeError;
    f.time+=120001;await f.router.poll();f.time+=16000;
    if(kind==='read-failure')f.readError=Error('offline');else f.snapshot.thread.status.type=kind;
    await f.router.poll();assert.deepEqual(f.writes,['A']);assert.equal(f.state.fixedQueue.review.length,0);
    delete f.readError;f.snapshot=snapshot(turn('old','old'));await f.router.poll();
    assert.deepEqual(f.writes,['A']);
  }
});

test('a lost completion association after a successful ACK cannot block forever or claim an unrelated answer',async()=>{
  const f=fixture();await f.accept(f.message('A'),f.message('B','bob'));f.time+=120001;f.snapshot=snapshot(turn('other','desktop input'));
  await f.router.poll();f.time+=15001;await f.router.poll();assert.deepEqual(f.writes,['A','B']);assert.equal(f.state.fixedQueue.review.length,1);assert.equal(f.answers().length,0);
});

test('late confirmed answers to reviewed input go only to the original requester and never replay the task',async()=>{
  const f=fixture();f.writeError=Error('timeout');await f.accept(f.message('A'));delete f.writeError;
  f.time+=120001;await f.router.poll();f.time+=15001;await f.router.poll();assert.equal(f.state.fixedQueue.review.length,1);
  await f.complete('a','A');assert.deepEqual(f.writes,['A']);assert.equal(f.state.fixedQueue.review.length,0);
  assert.equal(f.answers()[0].meta.openId,'alice');assert.match(f.answers()[0].text,/此前待核对消息/);
});

test('native receipt turn IDs and persisted user IDs associate completions even when message text is formatted',async()=>{
  for(const by of ['receipt','message']) {
    const f=fixture();if(by==='receipt')f.receipt={accepted:true,turnId:'a'};
    await f.accept(f.message('A'),f.message('B','bob'));
    const a=turn('a','wrapped native input');a.items[0].id=f.state.fixedQueue.active.clientUserMessageId;
    assert.match(a.items[0].id,/^[0-9a-f-]{36}$/);f.snapshot=snapshot(a);await f.router.poll();
    assert.deepEqual(f.writes,['A','B']);assert.equal(f.answers()[0].text,'答复 wrapped native input');
  }
});

test('restarting rechecks stable idle and preserves reviewed input without resending it',async()=>{
  const first=fixture();first.writeError=Error('timeout');await first.accept(first.message('A'),first.message('B','bob'));
  first.time+=120001;await first.router.poll();const state=structuredClone(first.state);first.router.stop();
  const f=fixture({state});f.time=first.time+30000;await f.router.poll();assert.deepEqual(f.writes,[]);
  f.time+=15001;await f.router.poll();assert.deepEqual(f.writes,['B']);assert.equal(f.state.fixedQueue.review[0].message.text,'A');
});

test('different bound conversations do not block each other even while one delivery is unknown',async()=>{
  const first=fixture();first.writeError=Error('timeout');await first.accept(first.message('A'));
  const second=fixture({desktop:first.desktop,threadId:'other-bound'});delete first.writeError;await second.accept(second.message('B','bob'));
  assert.deepEqual(first.writes,['A','B']);
});

test('a stale completed baseline cannot complete a newly acknowledged request for that same turn ID',async()=>{
  const f=fixture();f.receipt={accepted:true,turnId:'old'};await f.accept(f.message('A'),f.message('B','bob'));await f.router.poll();
  assert.deepEqual(f.writes,['A']);assert.equal(f.answers().length,0);
  const t=turn('old','A');t.items[0].id=f.state.fixedQueue.active.clientUserMessageId;f.snapshot=snapshot(t);await f.router.poll();
  assert.deepEqual(f.writes,['A','B']);assert.equal(f.answers()[0].text,'答复 A');
});

test('pending receipts distinguish unavailable desktop connection from executing work and update when the reason changes',async()=>{
  const f=fixture();f.readError=Error('offline');await f.accept(f.message('A'));await f.accept(f.message('B','bob'));
  assert.match(f.sent.at(-1).text,/无法连接目标会话/);assert.equal(f.state.fixedQueue.blockedReason,'connection');
  delete f.readError;f.snapshot={thread:{status:{type:'active'}},turns:[turn('local','local task','inProgress')]};await f.router.poll();
  assert.equal(f.state.fixedQueue.blockedReason,'busy');assert.match(f.sent.at(-1).text,/处理前面的任务/);assert.deepEqual(f.writes,[]);
});

test('desktop work that starts while loading holds the queue without steering and refreshes the final baseline',async()=>{
  const f=fixture();f.beforeSubmit=()=>{f.snapshot={thread:{status:{type:'active'}},turns:[turn('local','desktop work','inProgress')]};};
  await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);assert.equal(f.state.fixedQueue.active,null);
  assert.equal(f.state.fixedQueue.pending[0].text,'A');assert.equal(f.state.fixedQueue.blockedReason,'busy');
  delete f.beforeSubmit;f.snapshot=snapshot(turn('local','desktop work'));await f.router.poll();assert.deepEqual(f.writes,['A']);
  assert.deepEqual(f.state.fixedQueue.active.baselineTurnIds,['local']);
  await f.router.poll();assert.equal(f.answers().length,0);
});

test('a read failure after loading retains the unsent queue and persists the connection reason on each retry',async()=>{
  const f=fixture();f.beforeSubmit=()=>{f.readError=Error('offline');};
  await f.accept(f.message('A'));assert.deepEqual(f.writes,[]);assert.equal(f.state.fixedQueue.active,null);
  delete f.readError;await f.router.poll();assert.deepEqual(f.writes,[]);
  assert.equal(f.saved.at(-1).fixedQueue.blockedReason,'connection');assert.equal(f.state.fixedQueue.pending.length,1);
});

test('the opening budget survives retries and restarts for the whole queued batch',async()=>{
  let f,opens=0;
  const desktop={call:async(name,args,options)=>{
    if(name==='read_thread')return snapshot(turn('old','old'));
    if(options.beforeActivate())opens++;
    throw Object.assign(Error('not connected'),{notSent:true});
  }};
  f=fixture({desktop});await f.accept(f.message('A'),f.message('B','bob'));
  await f.router.poll();assert.equal(opens,1);assert.equal(f.saved.at(-1).fixedQueue.autoOpenAttempted,true);
  const state=structuredClone(f.state);f.router.stop();f=fixture({desktop,state});await f.router.poll();
  await f.accept(f.message('C','carol'));assert.equal(opens,1);assert.equal(f.state.fixedQueue.pending.length,3);
  // Only a new batch, after all old requests have left the queue, can open again.
  f.state.fixedQueue.pending=[];await f.accept(f.message('D'));assert.equal(opens,2);
});
