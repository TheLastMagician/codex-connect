import test from 'node:test';
import assert from 'node:assert/strict';
import {listCard,replyCard,escapeLabel} from '../src/cards.mjs';
import {CardActions} from '../src/card-actions.mjs';
import {createSender,chunkMarkdown} from '../src/outbound.mjs';
import {fixedReplyCards,fixedMarkdown} from '../src/fixed-cards.mjs';

const session={openId:'owner',chatId:'chat',projects:[{projectId:'p',label:'my_project',path:'C:\\Users\\Someone\\Documents\\my_project'}],
  threads:[],view:{id:'snapshot',kind:'projects',page:1},selected:{id:'thread',title:'当前会话',hostId:'local'}};
test('project cards use native layout and omit full private paths from the list',()=>{
  const issued=[];const card=listCard(session,action=>{issued.push(action);return `token-${issued.length}`;});
  assert.equal(card.schema,'2.0');assert.equal(card.header.title.content,'项目');
  assert.ok(card.body.elements.some(e=>e.tag==='column_set'));
  assert.ok(issued.some(a=>a.kind==='project' && a.project.projectId==='p'));
  assert.ok(!JSON.stringify(card).includes('Someone'));
  assert.ok(JSON.stringify(card).includes('查看'));
  assert.equal(escapeLabel('**title**<at>'), '\\*\\*title\\*\\*\\<at\\>');
});
test('assistant replies preserve Markdown and identify the actual source chat',()=>{
  const actions=[];
  const card=replyCard('**完成**\n```js\nconst x = 1;\n```',{kind:'assistant',thread:session.selected,session:{...session,mode:'chat'}},action=>{actions.push(action);return 'token';});
  assert.equal(card.header.title.content,'Codex 回复');assert.match(card.body.elements[0].content,/```js/);
  assert.ok(!JSON.stringify(card).includes('进入直聊'));assert.ok(!actions.some(action=>action.kind==='direct' || action.kind==='select'));
  const previous={...session.selected,id:'previous',title:'之前的会话'};
  const notification=replyCard('旧会话的回复',{kind:'assistant',thread:previous,session:{...session,mode:'chat'}},action=>{actions.push(action);return 'token';});
  assert.ok(JSON.stringify(notification).includes('切换到此会话'));
  assert.ok(actions.some(action=>action.kind==='select' && action.thread.id==='previous'));
});
function fixture() {
  const state={};const actions=new CardActions({state,saveState:()=>{},getConfig:()=>({allowedOpenIds:['owner']}),now:()=>10000});
  const token=actions.issue({openId:'owner',chatId:'chat'},{kind:'select',thread:session.selected});actions.bind([token],'message');
  const click=(openId='owner',chatId='chat',messageId='message')=>({operator:{open_id:openId},context:{open_chat_id:chatId,open_message_id:messageId},action:{value:{bridgeAction:token}}});
  return {state,actions,token,click};
}
test('card actions are bound to paired owner, original chat, original card and one click',()=>{
  const f=fixture();
  assert.equal(f.actions.consume(f.click('stranger')).context,undefined);
  assert.equal(f.actions.consume(f.click('owner','forwarded')).context,undefined);
  assert.equal(f.actions.consume(f.click('owner','chat','other-card')).context,undefined);
  const valid=f.actions.consume(f.click());assert.equal(valid.context.action.thread.id,'thread');
  assert.equal(f.actions.consume(f.click()).context,undefined);
});
test('expired and invented callback tokens never execute',()=>{
  const f=fixture();f.state.cardActions[f.token].expiresAt=9999;
  assert.equal(f.actions.consume(f.click()).context,undefined);
  assert.equal(f.actions.consume({operator:{open_id:'owner'},action:{value:{bridgeAction:'invented'}}}).context,undefined);
});
test('outbound creates interactive messages and updates the original card on a callback',async()=>{
  const calls=[];const state={sessions:{s:session}};const actions=new CardActions({state,saveState:()=>{},getConfig:()=>({allowedOpenIds:['owner']})});
  const client={im:{v1:{message:{create:async args=>{calls.push({method:'create',args});return {code:0,data:{message_id:'created'}};},
    patch:async args=>{calls.push({method:'patch',args});return {code:0};}}}}};
  const send=createSender({client,actions,state,saveState:()=>{},getConfig:()=>({cardActionsEnabled:true})});
  await send('chat','text',{kind:'list',session,openId:'owner'});
  assert.equal(calls[0].args.data.msg_type,'interactive');
  assert.ok(Object.values(state.cardActions).every(r=>r.messageId==='created'));
  await send('chat','updated',{kind:'list',session,openId:'owner',updateMessageId:'created'});
  assert.equal(calls[1].method,'patch');assert.equal(calls[1].args.path.message_id,'created');
});
test('a deleted card falls back to a fresh card without repeating the desktop operation',async()=>{
  const methods=[];const state={sessions:{s:session}};
  const client={im:{v1:{message:{patch:async()=>{methods.push('patch');return {code:230011};},
    create:async()=>{methods.push('create');return {code:0,data:{message_id:'new'}};}}}}};
  const send=createSender({client,actions:{},state,saveState:()=>{},getConfig:()=>({cardActionsEnabled:false})});
  await send('chat','response',{updateMessageId:'deleted'});assert.deepEqual(methods,['patch','create']);
});
test('long code replies retain code fences and never split Unicode characters',()=>{
  const content='前言\n```js\n'+('const emoji = "😀";\n'.repeat(300))+'```\n完成';
  const parts=chunkMarkdown(content,800);assert.ok(parts.length>1);
  for(const part of parts) {
    assert.ok(Array.from(part).length<=800);
    assert.equal((part.match(/^```/gm)||[]).length%2,0);
    assert.ok(!part.includes('\uFFFD'));
  }
  assert.equal(parts.join('\n').match(/const emoji/g).length,300);
});
test('fixed replies render native Markdown with the bot name and no commands or interactive controls',()=>{
  const text='**车辆状态**\n- `status:1`，间隔 5–15 秒\n\n**结论**：10:10 → 10:25，GPS 正常——司机端静默。';
  const [card]=fixedReplyCards(text,{botName:'项目小助手'});assert.equal(card.schema,'2.0');assert.equal(card.header.title.content,'项目小助手');
  assert.equal(card.body.elements[0].content,text);assert.ok(!JSON.stringify(card).includes('behaviors'));assert.ok(!JSON.stringify(card).includes('column_set'));
  assert.ok(!JSON.stringify(card).includes('/chats'));assert.ok(!JSON.stringify(card).includes('本机桌面'));
});
test('fixed formatting preserves punctuation and code and prevents model-authored notification tags',()=>{
  const text='\u001b[31m**正常**\u001b[0m\r\n`api/path`，29 秒 → 30 秒；😀\u0000\n<at id=all></at>';
  const clean=fixedMarkdown(text);assert.match(clean,/\*\*正常\*\*\n`api\/path`，29 秒 → 30 秒；😀/);
  assert.ok(!clean.includes('\u001b'));assert.ok(!clean.includes('\u0000'));assert.ok(!clean.includes('<at'));
  assert.ok(clean.includes('&lt;at id=all&gt;'));
});
test('long fixed cards keep complete code fences, number parts and mention only real recipients on the first card',()=>{
  const text='**结果**\n```js\n'+('const emoji = "😀";\n'.repeat(900))+'```\n完成。';
  const cards=fixedReplyCards(text,{mentionIds:['ou_alice','ou_alice','all','<at id=all>','ou_bob']});assert.ok(cards.length>1);
  assert.equal(cards[0].body.elements[0].content,'回复 <at id=ou_alice></at> <at id=ou_bob></at>');
  const blocks=cards.flatMap(card=>card.body.elements).filter(e=>e.tag==='markdown').map(e=>e.content);
  assert.equal(blocks.filter(content=>content.includes('<at')).length,1);
  assert.equal(blocks.join('\n').match(/const emoji/g).length,900);assert.equal(blocks.join('\n').includes('\uFFFD'),false);
  for(const card of cards){assert.match(card.header.subtitle.content,/第 \d+ \/ \d+ 部分/);const body=card.body.elements.at(-1).content;assert.equal((body.match(/^```/gm)||[]).length%2,0);}
});
