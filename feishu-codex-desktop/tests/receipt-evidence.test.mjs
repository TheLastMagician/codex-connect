import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {receiptEvidence,receiptCandidates,receiptHistoryComplete} from '../src/receipt-evidence.mjs';

const createdAt=1792293269485;
const canonical=(text='普通消息，保留符号。',overrides={})=>({id:randomUUID(),status:'completed',startedAt:Math.floor(createdAt/1000)+6,
  items:[{type:'userMessage',id:randomUUID(),content:[{type:'text',text}]}],...overrides});
const watch=(baseline=[])=>({clientUserMessageId:randomUUID(),createdAt,evidence:receiptEvidence('普通消息，保留符号。',baseline)});

test('canonical history with a different user item ID is correlated by new turn, submission time and exact input digest',()=>{
  const w=watch(),turn=canonical();assert.notEqual(turn.items[0].id,w.clientUserMessageId);
  assert.deepEqual(receiptCandidates([turn],w),{method:'evidence',turns:[turn]});
  assert.doesNotMatch(JSON.stringify(w.evidence),/普通消息|保留符号/);
  assert.notEqual(w.evidence.promptDigest,watch().evidence.promptDigest);
});

test('image receipts require the matching attachment as well as text and never match a text-only or different image turn',()=>{
  const bytes=Buffer.from('image bytes'),file='C:/private/photo.png';
  const w=watch();w.evidence=receiptEvidence('普通消息，保留符号。',[],[{path:file,digest:createHash('sha256').update(bytes).digest('hex')}]);
  const local=canonical();local.items[0].content.push({type:'localImage',path:file});
  assert.deepEqual(receiptCandidates([local],w).turns,[local]);
  const data=canonical();data.items[0].content.push({type:'image',url:'data:image/png;base64,'+bytes.toString('base64')});
  assert.deepEqual(receiptCandidates([data],w).turns,[data]);
  assert.equal(receiptCandidates([canonical()],w).turns.length,0);
  data.items[0].content[1].url='data:image/png;base64,'+Buffer.from('different image').toString('base64');
  assert.equal(receiptCandidates([data],w).turns.length,0);assert.ok(!JSON.stringify(w.evidence).includes(file));
});
test('identical historical input, missing timestamps, future work, provisional turns and partial input are not proof',()=>{
  const old=canonical(),w=watch([old]);
  const invalid=[old,canonical(undefined,{startedAt:createdAt/1000-10}),canonical(undefined,{startedAt:undefined}),
    canonical(undefined,{startedAt:createdAt/1000+121}),canonical(undefined,{id:'provisional'}),canonical('普通消息，保留符号。后续')];
  assert.deepEqual(receiptCandidates(invalid,w).turns,[]);
});
test('submission time after cold loading controls the matching interval',()=>{
  const w=watch();w.submittedAt=createdAt+60000;
  assert.equal(receiptCandidates([canonical()],w).turns.length,0);
  assert.equal(receiptCandidates([canonical(undefined,{startedAt:(w.submittedAt+5000)/1000})],w).turns.length,1);
});
test('repeated identical new messages remain ambiguous instead of choosing the latest',()=>{
  assert.equal(receiptCandidates([canonical(),canonical()],watch()).turns.length,2);
});
test('history ordering excludes older turns behind the pre-send anchor even within the same timestamp second',()=>{
  const anchor=canonical('baseline'),older=canonical(),newer=canonical(),w=watch([anchor]);
  assert.deepEqual(receiptCandidates([newer,anchor,older],w).turns,[newer]);
});
test('authoritative canonical clientId and a saved native turn ID take priority over input evidence',()=>{
  const w=watch(),turn=canonical('enriched input');turn.items[0].clientId=w.clientUserMessageId;
  assert.deepEqual(receiptCandidates([canonical(),turn],w),{method:'client',turns:[turn]});
  w.confirmedTurnId=turn.id;delete turn.items[0].clientId;
  assert.deepEqual(receiptCandidates([canonical(),turn],w),{method:'turn',turns:[turn]});
});
test('legacy receipts without evidence require an authoritative ID',()=>{
  const w={clientUserMessageId:randomUUID(),createdAt};
  assert.equal(receiptCandidates([canonical()],w).turns.length,0);
});
test('an explicit different canonical clientId cannot be overridden by identical input',()=>{
  const turn=canonical();turn.items[0].clientId=randomUUID();
  assert.equal(receiptCandidates([turn],watch()).turns.length,0);
});
test('history scanning continues until the baseline or the submission boundary has been reached',()=>{
  const old=canonical(undefined,{startedAt:createdAt/1000-2}),w=watch([old]);
  const page={hasMore:true,nextCursor:'older'};
  assert.equal(receiptHistoryComplete({page,turns:[canonical()]},w),false);
  assert.equal(receiptHistoryComplete({page,turns:[old]},w),true);
  assert.equal(receiptHistoryComplete({turns:[]},w),true);
  w.confirmedTurnId=canonical().id;
  assert.equal(receiptHistoryComplete({page,turns:[old]},w),false);
  assert.equal(receiptHistoryComplete({page,turns:[{id:w.confirmedTurnId}]},w),true);
});
