import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMessage} from '../src/router.mjs';
import {feishuText} from '../src/feishu-input.mjs';
const event=content=>({sender:{sender_type:'user',sender_id:{open_id:'owner'}},message:{message_id:'message',chat_id:'private',chat_type:'p2p',message_type:'post',create_time:String(Date.now()),content:JSON.stringify(content)}});
test('voice-converted rich text preserves punctuation, consecutive fragments and paragraph breaks',()=>{
  const raw=event({title:'',content:[[{tag:'text',text:'还是整形的类型，'},{tag:'text',text:'把那个改成字符串的回退了吧。'}],[{tag:'text',text:'先看看，别提交。'}]]});
  assert.equal(parseMessage(raw).text,'还是整形的类型，把那个改成字符串的回退了吧。\n先看看，别提交。');
  assert.equal(parseMessage(raw).id,'message');
});

test('the received post shape retains an NBSP paragraph and reads content_v2 rows only once',()=>{
  const content=[[{tag:'text',text:'这个模块的 Python 代码，你能提取出来吗？',style:[]}],[{tag:'text',text:'\u00a0',style:[]}],[{tag:'text',text:'找个目录放着就行了，你放到本机哈。',style:[]}]];
  const raw=event({title:'',content,content_v2:structuredClone(content)});
  assert.equal(parseMessage(raw).text,'这个模块的 Python 代码，你能提取出来吗？\n\u00a0\n找个目录放着就行了，你放到本机哈。');
  raw.message.content=JSON.stringify({content:[[{tag:'text',text:'legacy'}]],content_v2:[[{tag:'md',text:'新版正文，保留标点。'}]]});
  assert.equal(parseMessage(raw).text,'新版正文，保留标点。');
});
test('locale-wrapped posts and newer Markdown representations select one body without duplication',()=>{
  const raw=event({zh_cn:{title:'标题',content:[[{tag:'text',text:'正文'}]]},en_us:{title:'ignored',content:[[{tag:'text',text:'ignored'}]]}});
  assert.equal(parseMessage(raw).text,'标题\n正文');
  raw.message.content_v2=JSON.stringify({content:[[{tag:'md',text:'新版，原文。'}]]});
  assert.equal(parseMessage(raw).text,'新版，原文。');
  raw.message.content_v2='malformed';assert.equal(parseMessage(raw).text,'标题\n正文');
});
test('a rich-text group message requires the actual bot mention and preserves mentions of other people',()=>{
  const raw=event({content:[[{tag:'at',user_id:'ou_bot'},{tag:'text',text:' 帮我看看，'},{tag:'at',user_id:'ou_person'},{tag:'text',text:' 的订单。'}]]});
  raw.message.chat_type='group';raw.message.mentions=[{key:'@_user_1',id:{open_id:'ou_bot'},name:'Codex'},{key:'@_user_10',id:{open_id:'ou_person'},name:'同事'}];
  assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}).text,'帮我看看，@同事 的订单。');
  assert.equal(parseMessage(raw,{botOpenId:'ou_other'}),null);
  raw.message.content=JSON.stringify({content:[[{tag:'at',user_id:'all'},{tag:'text',text:' 不该触发'}]]});assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}),null);
  raw.message.content=JSON.stringify({content:[[{tag:'at',user_id:'ou_fake',user_name:'Codex'},{tag:'text',text:' 不该触发'}]]});assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}),null);
});
test('Markdown at tags need matching platform metadata and bare mentions retain the local usage hint',()=>{
  const raw=event({content:[[{tag:'md',text:'<at user_id="ou_bot">机器人</at> 你好，查一下。'}]]});raw.message.chat_type='group';
  raw.message.mentions=[{key:'@_user_1',id:{open_id:'ou_bot'},name:'Codex'}];
  assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}).text,'你好，查一下。');
  raw.message.mentions=[];assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}),null);
  raw.message.mentions=[{key:'@_user_1',id:{open_id:'ou_bot'},name:'Codex'}];raw.message.content=JSON.stringify({content:[[{tag:'at',user_id:'ou_bot'}]]});
  assert.equal(parseMessage(raw,{botOpenId:'ou_bot'}).mentionOnly,true);
});
test('links and code blocks remain literal and cannot turn examples into management commands',()=>{
  const raw=event({content:[[{tag:'a',text:'/archive',href:'https://example.com'}],[{tag:'code_block',language:'BASH',text:'/archive\n```'}]]});
  const parsed=parseMessage(raw);assert.ok(parsed.text.startsWith('[/archive](https://example.com)'));
  assert.ok(parsed.text.includes('````BASH\n/archive\n```\n````'));
});
test('invalid, oversized and nontext payloads cannot become tasks; media keys never become prompts',()=>{
  for(const content of [{content:[[{tag:'img',image_key:'private-key'}]]},{content:[[{tag:'unknown',text:'must not run'}]]},{content:[{}]},{content:[[{tag:'text',text:'x'.repeat(12001)}]]}])assert.equal(parseMessage(event(content)),null);
  const raw=event({text:'not a transcription',file_key:'private'});raw.message.message_type='audio';assert.equal(parseMessage(raw),null);
  raw.message.message_type='interactive';assert.equal(parseMessage(raw),null);
  assert.equal(feishuText({message_type:'post',content:{content:[[{tag:'text',text:'文字'}, {tag:'img',image_key:'secret'}]]}}),'文字[图片附件未传入 Codex]');
});
