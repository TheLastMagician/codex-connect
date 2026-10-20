import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ManagedChatRouter} from '../src/managed-router.mjs';
import {FixedChatRouter} from '../src/fixed-router.mjs';

const snapshot=(turn,status=turn?.status==='inProgress'?'active':'idle')=>({thread:{status:{type:status}},turns:turn?[turn]:[]});
function turn(text,time,status='completed',id=randomUUID()) {
  return {id,startedAt:Math.floor(time/1000),status,items:[{type:'userMessage',id:randomUUID(),content:[{type:'text',text}]},
    ...(status==='completed'?[{type:'agentMessage',id:'answer-'+id,text:'答复 '+text,phase:'final_answer'}]:[])]};
}
function fixture({state={},desktop}={}) {
  const f={state,time:1792300000000,allowed:new Set(['alice','bob']),sent:[],writes:[],snapshots:new Map(),saveCount:0};
  f.desktop=desktop||{call:async(name,args,options)=>{
    if(name==='read_thread'){if(f.readError)throw f.readError;if(!f.snapshots.has(args.threadId))f.snapshots.set(args.threadId,snapshot(turn('旧任务',f.time-100000)));return f.snapshots.get(args.threadId);}
    if(name==='list_threads')return {threads:[{id:'a',kind:'codex',hostId:'local',title:'A'},{id:'b',kind:'codex',hostId:'local',title:'B'}]};
    if(name==='list_projects')return {projects:[]};
    if(name!=='send_message_to_thread')return {};
    assert.equal(options.onLoading,undefined);options.beforeSend();await f.beforeNative?.();
    try {await options.beforeSubmit?.();options.beforeSend();}catch(e){throw Object.assign(e,{notSent:true});}
    f.writes.push({...args});const next=turn(args.prompt,f.time,'inProgress');
    if(!f.dropInput)f.snapshots.set(args.threadId,snapshot(next));
    if(f.loseAck)throw Error('native ACK timeout');
    return {accepted:true,turnId:next.id};
  }};
  f.router=new ManagedChatRouter({desktop:f.desktop,state,getConfig:()=>({allowedOpenIds:[...f.allowed]}),saveState:()=>{f.saveCount++;},
    isAuthorized:id=>f.allowed.has(id),now:()=>f.time,send:async(chat,text,meta)=>{if(f.sendError)throw f.sendError;f.sent.push({chat,text,meta});}});
  f.message=(text,user='alice',chat='private')=>({id:randomUUID(),openId:user,chatId:chat,text,timestamp:f.time});
  f.select=(id,user='alice',chat='private')=>{
    const s=f.router.session(f.message('',user,chat));f.router.selectThread(s,{id,title:id.toUpperCase(),kind:'codex',hostId:'local'});return s;
  };
  f.deliver=async(text,user='alice',chat='private')=>{assert.equal(f.router.acceptMessage(f.message(text,user,chat)),true);await flush(f);};
  f.complete=(id='a')=>{const current=f.snapshots.get(id).turns[0];f.snapshots.set(id,snapshot(turn(current.items[0].content[0].text,f.time,'completed',current.id)));};
  f.poll=async()=>{await f.router.poll();await flush(f);};
  f.answers=()=>f.sent.filter(s=>s.meta.kind==='assistant');return f;
}
async function flush(f) {
  await Promise.all(f.router.queues.values());await Promise.resolve();
  await Promise.all([...f.router.workers.values()].flatMap(w=>[...w.queues.values()]));
  await Promise.all([...f.router.workers.values()].map(w=>w.deliveryWork));
}

test('management messages wait for actual completion, not an ACK, and return separate answers',async()=>{
  const f=fixture();f.select('a');await f.deliver('第一条');await f.deliver('第二条');
  assert.deepEqual(f.writes.map(w=>w.prompt),['第一条']);assert.match(f.sent.at(-1).text,/已排队/);
  await f.poll();assert.equal(f.writes.length,1);assert.equal(f.answers().length,0);
  f.complete();await f.poll();assert.deepEqual(f.writes.map(w=>w.prompt),['第一条','第二条']);
  f.complete();await f.poll();assert.deepEqual(f.answers().map(s=>s.text),['答复 第一条','答复 第二条']);
  assert.ok(!f.sent.some(s=>s.meta.title==='会话加载中'));await f.poll();assert.equal(f.answers().length,2);
});
test('queued destinations and model overrides survive commands, chat switches and restart',async()=>{
  const f=fixture(),s=f.select('a');s.modelOverrides={'local:a':{model:'model-one',thinking:'high'}};
  await f.deliver('A1');await f.deliver('A2');f.select('b');await f.deliver('B1');
  s.modelOverrides['local:a']={model:'changed-model'};
  assert.deepEqual(f.writes.map(w=>[w.threadId,w.prompt]),[['a','A1'],['b','B1']]);
  const saved=structuredClone(f.state);f.router.stop();const restored=fixture({state:saved});restored.snapshots=f.snapshots;
  restored.complete('a');await restored.poll();assert.equal(restored.writes[0].threadId,'a');assert.equal(restored.writes[0].prompt,'A2');
  assert.equal(restored.writes[0].model,'model-one');assert.equal(restored.writes[0].thinking,'high');
  assert.equal(restored.state.sessions['alice:private'].selected.id,'b');
});
test('groups and people sharing a target use one FIFO while unrelated targets stay independent',async()=>{
  const f=fixture();f.select('a','alice','group-one');f.select('a','bob','group-two');f.select('b','alice','other');
  await f.deliver('A','alice','group-one');await f.deliver('B','bob','group-two');await f.deliver('C','alice','other');
  assert.deepEqual(f.writes.map(w=>w.prompt),['A','C']);f.complete('a');await f.poll();assert.equal(f.writes.at(-1).prompt,'B');
  f.complete('a');await f.poll();assert.deepEqual(f.answers().filter(s=>s.meta.thread.id==='a').map(s=>s.chat),['group-one','group-two']);
});
test('a lost native ACK matches canonical message IDs and never replays the input',async()=>{
  const f=fixture();f.select('a');f.loseAck=true;await f.deliver('A');delete f.loseAck;await f.deliver('B');
  assert.equal(Object.values(f.state.taskQueues)[0].fixedQueue.active.phase,'waiting');
  assert.equal(f.sent.filter(s=>s.meta.title==='任务已发送').length,1);
  assert.ok(!f.sent.some(s=>s.meta.title==='发送核对中'));
  await f.poll();assert.equal(f.writes.length,1);f.complete();await f.poll();assert.deepEqual(f.writes.map(w=>w.prompt),['A','B']);
  assert.equal(f.answers()[0].text,'答复 A');
});

test('delayed receipt visibility is reconciled quietly and later polls do not repeat acceptance',async()=>{
  const f=fixture();f.select('a');f.loseAck=true;f.dropInput=true;await f.deliver('A');
  delete f.loseAck;delete f.dropInput;const queue=Object.values(f.state.taskQueues)[0].fixedQueue;
  assert.equal(queue.active.phase,'uncertain');assert.equal(f.sent.length,0);
  await f.deliver('B');assert.match(f.sent.at(-1).text,/已排队/);
  f.time+=5000;f.snapshots.set('a',snapshot(turn('A',f.time,'inProgress')));await f.poll();
  assert.equal(queue.active.phase,'waiting');assert.equal(f.writes.length,1);
  f.time+=40000;await f.poll();assert.ok(!f.sent.some(s=>s.meta.title==='发送核对中'));
  assert.equal(f.sent.filter(s=>s.meta.title==='任务已发送').length,1);
  f.complete();await f.poll();assert.deepEqual(f.writes.map(w=>w.prompt),['A','B']);assert.equal(f.answers()[0].text,'答复 A');
});

test('persistent unknown delivery warns once after the grace period, survives restart and never replays',async()=>{
  const first=fixture();first.select('a');first.loseAck=true;first.dropInput=true;await first.deliver('A');
  first.time+=29999;await first.poll();assert.equal(first.sent.length,0);
  const saved=structuredClone(first.state);first.router.stop();const f=fixture({state:saved});
  f.time=first.time+2;f.snapshots=first.snapshots;f.readError=Error('offline');
  await f.poll();await f.poll();assert.equal(f.sent.filter(s=>s.meta.title==='发送核对中').length,1);
  assert.equal(Object.values(f.state.taskQueues)[0].fixedQueue.active.phase,'uncertain');assert.equal(f.writes.length,0);
  delete f.readError;f.snapshots.set('a',snapshot(turn('A',f.time,'inProgress')));await f.poll();
  assert.equal(Object.values(f.state.taskQueues)[0].fixedQueue.active.phase,'waiting');
  f.complete();await f.poll();assert.equal(f.answers()[0].text,'答复 A');assert.equal(f.writes.length,0);
});
test('desktop work starting before submission keeps input queued instead of steering it',async()=>{
  const f=fixture();f.select('a');f.beforeNative=()=>{f.snapshots.set('a',snapshot(turn('桌面任务',f.time,'inProgress')));};
  await f.deliver('A');assert.equal(f.writes.length,0);delete f.beforeNative;
  await f.poll();assert.equal(f.writes.length,0);f.complete();await f.poll();assert.equal(f.writes[0].prompt,'A');
  assert.equal(f.answers().length,0);
});
test('read failures preserve queued input and revoked senders cannot dispatch or receive an answer',async()=>{
  const f=fixture();f.select('a');f.select('a','bob');f.readError=Error('offline');await f.deliver('A');
  assert.equal(f.writes.length,0);delete f.readError;await f.poll();await f.deliver('B','bob');
  f.allowed.delete('alice');f.complete();await f.poll();assert.equal(f.writes.at(-1).prompt,'B');assert.equal(f.answers().length,0);
});
test('failed reply delivery retries independently while the next queued task runs',async()=>{
  const f=fixture();f.select('a');await f.deliver('A');await f.deliver('B');f.complete();f.sendError=Error('offline');
  await f.poll();assert.equal(f.writes.length,2);delete f.sendError;f.time+=5001;await f.poll();
  assert.deepEqual(f.writes.map(w=>w.prompt),['A','B']);assert.equal(f.answers().filter(s=>s.text==='答复 A').length,1);
});
test('unmatched delivery leaves the active barrier only after stable idle checks and never replays itself',async()=>{
  const f=fixture();f.select('a');f.loseAck=true;f.dropInput=true;await f.deliver('A');delete f.loseAck;delete f.dropInput;
  await f.deliver('B');f.time+=120001;await f.poll();f.time+=15001;await f.poll();
  assert.deepEqual(f.writes.map(w=>w.prompt),['A','B']);assert.equal(f.answers().length,0);
  assert.equal(Object.values(f.state.taskQueues)[0].fixedQueue.review[0].message.text,'A');
});
test('management and dedicated bots share the target lease',async()=>{
  const f=fixture();f.select('a');await f.deliver('A');
  const fixed=new FixedChatRouter({thread:{id:'a',hostId:'local'},desktop:f.desktop,state:{},saveState:()=>{},getConfig:()=>({}),
    isAuthorized:()=>true,now:()=>f.time,send:async()=>{}});
  fixed.acceptMessage(f.message('B'));await fixed.poll();assert.equal(f.writes.length,1);
  f.complete();await f.poll();await fixed.poll();assert.equal(f.writes.at(-1).prompt,'B');fixed.stop();
});
test('queue records exclude connector tokens and status remains usable while work is active',async()=>{
  const f=fixture();f.select('a');const message={...f.message('A'),contextToken:'private-connector-token'};
  f.router.acceptMessage(message);await flush(f);await f.deliver('B');await f.deliver('/status');
  assert.match(f.sent.at(-1).text,/消息队列：1 条等待/);assert.doesNotMatch(JSON.stringify(f.state.taskQueues),/private-connector-token/);
  assert.equal(f.writes.length,1);
});

test('cold loading keeps commands responsive and safely resumes an unsent preparation after restart',async()=>{
  const f=fixture();f.select('a');let release,entered;
  const loading=new Promise(resolve=>{entered=resolve;});
  f.beforeNative=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  f.router.acceptMessage(f.message('A'));await loading;
  f.router.acceptMessage(f.message('B'));await Promise.all(f.router.queues.values());
  f.router.acceptMessage(f.message('/status'));await Promise.all(f.router.queues.values());
  assert.match(f.sent.at(-1).text,/消息队列：1 条等待；当前等待连接/);
  assert.ok(!f.sent.some(s=>s.meta.title==='会话加载中'));assert.equal(f.writes.length,0);
  const saved=structuredClone(f.state);f.router.stop();release();await flush(f);
  assert.equal(f.writes.length,0);
  const restored=fixture({state:saved});await restored.poll();
  assert.deepEqual(restored.writes.map(w=>w.prompt),['A']);
  restored.complete();await restored.poll();assert.deepEqual(restored.writes.map(w=>w.prompt),['A','B']);
});

test('revocation during loading prevents the queued native write',async()=>{
  const f=fixture();f.select('a');f.beforeNative=()=>{f.allowed.delete('alice');};
  await f.deliver('A');assert.equal(f.writes.length,0);await f.poll();assert.equal(f.writes.length,0);
});

test('replayed events cannot add another queue item and overflow is explicitly rejected',async()=>{
  const f=fixture();f.select('a');const message=f.message('A');
  assert.equal(f.router.acceptMessage(message),true);await flush(f);
  assert.equal(f.router.acceptMessage(message),false);assert.equal(f.writes.length,1);
  const queue=Object.values(f.state.taskQueues)[0].fixedQueue;
  queue.pending=Array.from({length:99},(_,i)=>({...f.message('pending '+i),modelArgs:{}}));
  await f.deliver('overflow');assert.match(f.sent.at(-1).text,/等待队列已满/);
  assert.equal(queue.pending.length,99);assert.equal(f.writes.length,1);
});
