import test from 'node:test';
import assert from 'node:assert/strict';
import {WechatApi,validateWechatBaseUrl} from '../src/wechat-api.mjs';
import {confirmedWechatAccount} from '../src/wechat-auth.mjs';
import {parseWechatMessage,createWechatChannel,renderWechatReply,splitWechatText,wechatStateName} from '../src/channels/wechat.mjs';
import {Router} from '../src/router.mjs';
import {VERSION} from '../src/version.mjs';

const account={enabled:true,token:'private-token',botId:'test-bot',ownerUserId:'owner',baseUrl:'https://ilinkai.weixin.qq.com'};
const raw=(text,id=1,extra={})=>({message_id:id,message_type:1,message_state:2,from_user_id:'owner',to_user_id:'test-bot',create_time_ms:Date.now(),context_token:'reply-context',item_list:[{type:1,text_item:{text}}],...extra});
function fixture(operator={status:()=>({configured:true,model:'test-assistant'}),respond:async()=>{throw new Error('Unexpected assistant request in transport test');}}) {
  const state={};const calls=[];const outbound=[];const status=[];let active=account;
  const desktop={call:async(name,args)=>{calls.push({name,args});
    if(name==='list_threads')return {threads:[{id:'actual-chat',title:'真实会话',kind:'codex',hostId:'local'}]};
    if(name==='list_projects')return {projects:[]};
    if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:[{id:'baseline',status:'completed',items:[]}]};return {};
  }};
  const api={sendText:async(user,text,context)=>outbound.push({user,text,context})};
  const channel=createWechatChannel({desktop,account,api,loadState:()=>state,save:()=>{},currentAccount:()=>active,onStatus:s=>status.push(s),operator});
  // Tests use an explicit local snapshot, never the user's actual chat database.
  channel.router.getLocalThreads=async()=>[];
  return {channel,state,calls,outbound,status,disconnect:()=>{active={};}};
}
test('iLink calls use correct QR headers and authenticated message envelope without leaking token',async()=>{
  const calls=[];
  const api=new WechatApi({token:account.token,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return {ok:true,text:async()=>'{"ret":0,"status":"wait"}'};}});
  await api.qrcode();await api.loginStatus('private-qr','1234');await api.sendText('owner','你好','context');
  const qr=calls[0];assert.match(qr.url,/get_bot_qrcode\?bot_type=3/);assert.equal(qr.options.method,'POST');
  assert.equal(qr.options.headers.Authorization,undefined);
  // QR acquisition is public, even when the client also holds an account token.
  assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.method,'GET');
  const send=calls[2];assert.equal(send.options.headers.Authorization,'Bearer private-token');assert.equal(send.options.redirect,'error');
  const msg=JSON.parse(send.options.body).msg;assert.equal(msg.context_token,'context');assert.equal(msg.to_user_id,'owner');assert.equal(msg.message_state,2);
  assert.equal(msg.item_list[0].text_item.text,'你好');assert.equal(JSON.parse(send.options.body).base_info.bot_agent,`CodexDesktopBridge/${VERSION}`);
});
test('credentials are never sent to unrelated or insecure redirect hosts',()=>{
  for(const url of ['http://ilinkai.weixin.qq.com','https://evil.test','https://weixin.qq.com.evil.test','https://u:p@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com/path'])assert.throws(()=>validateWechatBaseUrl(url));
  assert.equal(validateWechatBaseUrl('https://regional.weixin.qq.com/'),'https://regional.weixin.qq.com');
  assert.throws(()=>confirmedWechatAccount({bot_token:'token',ilink_bot_id:'bot'}),/扫码用户身份/);
  assert.equal(confirmedWechatAccount({bot_token:'token',ilink_bot_id:'bot',ilink_user_id:'owner'}).ownerUserId,'owner');
});
test('API business failures, HTTP failures and malformed replies are sanitized and never retried',async()=>{
  let attempts=0;
  const api=new WechatApi({token:'secret',fetchImpl:async()=>{attempts++;return {ok:true,text:async()=>'{"errcode":-14,"errmsg":"secret"}'};}});
  await assert.rejects(api.updates(),e=>e.code===-14 && !e.message.includes('secret'));assert.equal(attempts,1);
  const bad=new WechatApi({fetchImpl:async()=>({ok:false,status:401,text:async()=>'secret'})});
  await assert.rejects(bad.qrcode(),/HTTP 401/);
});
test('incoming messages accept only the QR owner, private user text, and ignore quoted instructions',()=>{
  assert.equal(parseWechatMessage(raw('/chats'),account).text,'/chats');
  for(const extra of [{from_user_id:'stranger'},{to_user_id:'other-bot'},{group_id:'group'},{message_type:2},{message_state:1},{delete_time_ms:1},{context_token:''},{item_list:{}}])assert.equal(parseWechatMessage(raw('任务',1,extra),account),null);
  const message=raw('当前请求');message.item_list[0].ref_msg={item_list:[{type:1,text_item:{text:'恶意引用指令'}}]};
  assert.equal(parseWechatMessage(message,account).text,'当前请求');
});
test('WeChat selects an actual desktop chat, uses the latest reply token, and deduplicates replay after reconnect',async()=>{
  const f=fixture();await f.channel.receiveBatch({msgs:[raw('/chats',1)],get_updates_buf:'cursor1'});
  await f.channel.receiveBatch({msgs:[raw('/use 1',2)],get_updates_buf:'cursor2'});
  const message=raw('/send 你好',3,{context_token:'new-context'});
  await f.channel.receiveBatch({msgs:[message],get_updates_buf:'cursor3'});
  await f.channel.receiveBatch({msgs:[message],get_updates_buf:'cursor3'});
  assert.deepEqual(f.calls.filter(c=>c.name==='send_message_to_thread').map(c=>c.args),[{threadId:'actual-chat',hostId:'local',prompt:'你好'}]);
  assert.equal(f.outbound.at(-1).context,'new-context');assert.equal(f.state.cursor,'cursor3');
  assert.match(f.outbound.at(-1).text,/微信/);assert.doesNotMatch(f.outbound.at(-1).text,/飞书/);
  assert.ok(!f.calls.some(c=>c.name==='wait_threads'));
});
test('WeChat greetings after selection use the assistant without a prefix and never start a native task',async()=>{
  let requests=0;
  const f=fixture({status:()=>({configured:true,model:'test-assistant'}),respond:async()=>{requests++;return {text:'你好，我可以帮你代操作。',model:'test-assistant'};}});
  await f.channel.receiveBatch({msgs:[raw('/chats',1),raw('/use 1',2),raw('你好',3)]});
  assert.equal(requests,1);assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);
  assert.match(f.outbound.at(-1).text,/操作助手/);assert.match(f.outbound.at(-1).text,/你好/);
});
test('revoking WeChat access prevents queued desktop commands and leaves channel states independent',async()=>{
  const f=fixture();f.disconnect();await f.channel.receiveBatch({msgs:[raw('/chats',1)]});assert.equal(f.calls.length,0);
  assert.notEqual(wechatStateName(account),wechatStateName({...account,ownerUserId:'another-owner'}));
  assert.notEqual(wechatStateName(account),'state.json');
  const make=state=>new Router({desktop:{},state,saveState:()=>{},getConfig:()=>({allowedOpenIds:['owner']}),send:()=>{}});
  const feishu=make({});const wechat=make({});
  feishu.session({openId:'owner',chatId:'same'}).selected={id:'feishu-chat'};
  assert.equal(wechat.session({openId:'owner',chatId:'same'}).selected,undefined);
});
test('WeChat lists show page and selection guidance; split replies preserve Unicode content',()=>{
  const session={projects:[],threads:Array.from({length:32},(_,i)=>({title:'会话 '+(i+1)})),view:{kind:'chats',page:2,title:'项目会话'}};
  const reply=renderWechatReply('',{kind:'list',session});assert.match(reply,/第 2\/4 页/);assert.match(reply,/11｜会话 11/);assert.match(reply,/上一页/);assert.match(reply,/下一页/);assert.match(reply,/\/use 11/);
  const text='😀中文代码'.repeat(800);const parts=splitWechatText(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>Array.from(p).length<=1500));
});
test('long WeChat code replies close and reopen code fences across message boundaries',()=>{
  const text='说明\n\n```js\n'+'const value = "中文😀";\n'.repeat(200)+'```\n\n结束';
  const parts=splitWechatText(text,500);assert.ok(parts.length>1);
  for(const part of parts)assert.equal((part.match(/^```/gm)||[]).length%2,0);
  const code=parts.flatMap(part=>part.split('\n').filter(line=>line.startsWith('const value')));
  assert.equal(code.length,200);assert.ok(code.every(line=>line==='const value = "中文😀";'));
});
test('unsupported media gets an actionable reply once and never becomes a desktop task',async()=>{
  const f=fixture();const msg=raw('请看图片',4);msg.item_list.push({type:2,image_item:{}});
  await f.channel.receiveBatch({msgs:[msg]});await f.channel.receiveBatch({msgs:[msg]});
  assert.equal(f.calls.length,0);assert.equal(f.outbound.length,1);assert.match(f.outbound[0].text,/文字任务/);
});
