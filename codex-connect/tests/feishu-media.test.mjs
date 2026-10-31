import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFeishuMedia,imageReferences,defaultFeishuImageRoots} from '../src/feishu-media.mjs';
import {createCardWriter,createSender} from '../src/outbound.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-media-test-'));
  const file=path.join(root,'chart (一).png');await fs.writeFile(file,png);
  const f={root,file,state:{},uploads:[],reports:[],allowed:true,saves:0};
  f.client={im:{v1:{image:{create:async args=>{f.uploads.push(args);if(f.error)throw f.error;return {image_key:'img_fixture_1'};}}}}};
  f.media=createFeishuMedia({client:f.client,state:f.state,saveState:()=>f.saves++,roots:[root],namespace:'bot',canSend:()=>f.allowed,report:e=>f.reports.push(e)});
  f.close=async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-media-test-'));await fs.rm(root,{recursive:true,force:true,maxRetries:5});};return f;
}

test('Windows includes conventional temporary folders without allowing the entire drive or network shares',()=>{
  const roots=defaultFeishuImageRoots({platform:'win32',home:'C:\\Users\\owner',temporary:'D:\\SessionTemp'});
  for(const root of ['C:\\temp','C:\\tmp','D:\\temp','D:\\tmp','D:\\SessionTemp'])assert.ok(roots.includes(root),root);
  assert.ok(!roots.includes('C:\\'));assert.ok(!roots.includes('D:\\'));
  const network=defaultFeishuImageRoots({platform:'win32',home:'\\\\server\\home',temporary:'C:\\Temp'});
  assert.ok(!network.includes('\\\\server\\home\\temp'));
  assert.ok(!defaultFeishuImageRoots({platform:'linux',home:'/home/owner',temporary:'/tmp'}).includes('C:\\temp'));
});

test('resolves the real project for image replies only and resolves it once for multiple images',async()=>{
  const f=await fixture();try {
    let reads=0;
    const media=createFeishuMedia({client:f.client,state:f.state,saveState:()=>{},roots:[],resolveThread:async thread=>{
      reads++;return {...thread,cwd:f.root};
    }});
    const meta={thread:{id:'selected-chat',hostId:'local'}};
    assert.equal(await media.prepare('普通文字',meta),'普通文字');assert.equal(reads,0);
    const relative=path.basename(f.file);
    const output=await media.prepare(`![一](<${relative}>)\n![二](<${relative}>)`,meta);
    assert.equal(reads,1);assert.equal(f.uploads.length,1);assert.equal(output,'![一](img_fixture_1)\n![二](img_fixture_1)');
  }finally{await f.close();}
});

test('a different thread or host cannot supply a project directory and lookup failure preserves allowed temporary images',async()=>{
  const f=await fixture();try {
    const meta={thread:{id:'selected-chat',hostId:'local'}};
    for(const resolved of [{id:'other-chat',cwd:f.root},{id:'selected-chat',hostId:'remote',cwd:f.root}]) {
      const media=createFeishuMedia({client:f.client,state:{},saveState:()=>{},roots:[],resolveThread:async()=>resolved});
      assert.match(await media.prepare(`![图](${f.file})`,meta),/图片不在会话项目或临时、生成目录中/);
    }
    assert.equal(f.uploads.length,0);
    const media=createFeishuMedia({client:f.client,state:{},saveState:()=>{},roots:[f.root],resolveThread:async()=>{throw Error('private desktop details');}});
    assert.equal(await media.prepare(`![图](${f.file})`,meta),'![图](img_fixture_1)');assert.equal(f.uploads.length,1);
  }finally{await f.close();}
});
test('uploads a generated image, keeps its position and reuses the key across retries and restarts',async()=>{
  const f=await fixture();try {
    const text=`开头\n![图表](${f.file})\n**结论**`;
    const prepared=await f.media.prepare(text,{});assert.equal(prepared,'开头\n![图表](img_fixture_1)\n**结论**');
    assert.equal(f.uploads.length,1);assert.deepEqual(f.uploads[0].data,{image_type:'message',image:png});
    await f.media.prepare(text,{});assert.equal(f.uploads.length,1);
    const restored=createFeishuMedia({client:f.client,state:structuredClone(f.state),saveState:()=>{},roots:[f.root],namespace:'bot'});
    await restored.prepare(text,{});assert.equal(f.uploads.length,1);
    const otherBot=createFeishuMedia({client:f.client,state:f.state,saveState:()=>{},roots:[f.root],namespace:'other-bot'});
    await otherBot.prepare(text,{});assert.equal(f.uploads.length,2);
  }finally{await f.close();}
});
test('parses quoted paths, parentheses, file URLs and ignores code examples',async()=>{
  const f=await fixture();try {
    const text=`\`![inline](${f.file})\`\n\`\`\`md\n![code](${f.file})\n\`\`\`\n![actual](<${f.file}>)\n![URL](${pathToFileURL(f.file).href})`;
    assert.deepEqual(imageReferences(text).map(ref=>ref.alt),['actual','URL']);
    const output=await f.media.prepare(text,{});assert.ok(output.includes('![actual](img_fixture_1)'));assert.ok(output.includes('![URL](img_fixture_1)'));
    assert.equal(f.uploads.length,1);assert.ok(output.includes('![inline]('+f.file+')'));
    assert.equal(imageReferences('![图](<C:/charts/plot ) v2.png>)')[0].destination,'C:/charts/plot ) v2.png');
  }finally{await f.close();}
});
test('a partial reply keeps its prepared images stable if the local file disappears before retry',async()=>{
  const f=await fixture();try {
    const text=`![图](${f.file})\n结论`,meta={deliveryId:'completed-reply'};
    const prepared=await f.media.prepare(text,meta);await fs.unlink(f.file);
    assert.equal(await f.media.prepare(text,meta),prepared);assert.ok(prepared.includes('img_fixture_1'));
    f.media.forget(meta.deliveryId);assert.match(await f.media.prepare(text,meta),/图片暂未发送/);
  }finally{await f.close();}
});
test('missing, unsupported, outside-root, remote and oversized images never block the text reply',async()=>{
  const f=await fixture();try {
    const outside=await fs.mkdtemp(path.join(os.tmpdir(),'codex-media-outside-'));
    try {
      const external=path.join(outside,'private.png');await fs.writeFile(external,png);
      const fake=path.join(f.root,'not-image.png');await fs.writeFile(fake,'private credential text');
      const big=path.join(f.root,'too-big.png');await fs.writeFile(big,Buffer.alloc(10*1024*1024+1));
      for(const value of [path.join(f.root,'missing.png'),external,fake,big,'https://example.com/image.png','file://server/share/image.png']) {
        const output=await f.media.prepare(`正文\n![图](${value})\n结论`,{});
        assert.match(output,/正文[\s\S]*图片暂未发送[\s\S]*结论/);assert.ok(!output.includes(value));
      }
      assert.deepEqual(f.reports.map(r=>r.reason),['missing_file','outside_root','unsupported_format','too_large','external_url','network_path']);
      assert.equal(f.uploads.length,0);
    }finally{assert.ok(outside.startsWith(os.tmpdir()+path.sep+'codex-media-outside-'));await fs.rm(outside,{recursive:true,force:true,maxRetries:5});}
    f.allowed=false;await f.media.prepare(`![图](${f.file})`,{});assert.equal(f.uploads.length,0);
    f.allowed=true;await f.media.prepare(`![图](${f.file})`,{thread:{hostId:'remote'}});assert.equal(f.uploads.length,0);
  }finally{await f.close();}
});
test('image upload permission failures return readable text and sanitized diagnostics',async()=>{
  const f=await fixture();try {
    f.error={response:{status:403,data:{code:99991672,msg:'sensitive request',appSecret:'private'}}};
    const output=await f.media.prepare(`文字 ![图](${f.file}) 后文`,{});assert.match(output,/图片暂未发送/);
    assert.match(output,/飞书图片上传失败（错误码 99991672）/);assert.equal(f.reports[0].reason,'upload_failed');
    assert.equal(f.reports[0].code,99991672);assert.equal(f.reports[0].status,403);assert.ok(!JSON.stringify(f.reports).includes('private'));
  }finally{await f.close();}
});
test('multipart reply retries skip acknowledged cards and reuse UUID only inside its deduplication window',async()=>{
  const state={},calls=[];let time=1000,fail=true;
  const client={im:{v1:{message:{create:async args=>{calls.push(args);if(fail && calls.length===2)throw Error('ACK lost');return {code:0,data:{message_id:'sent-'+calls.length}};}}}}};
  const write=createCardWriter({client,state,saveState:()=>{},now:()=>time});
  const payload={chatId:'chat',openId:'user',card:{schema:'2.0'},deliveryId:'reply'};
  await write({...payload,index:0});await assert.rejects(write({...payload,index:1}));
  fail=false;await write({...payload,index:0});await write({...payload,index:1});
  assert.equal(calls.length,3);assert.equal(calls[1].data.uuid,calls[2].data.uuid);
  const lostClient={im:{v1:{message:{create:async()=>{throw Error('ACK lost');}}}}};
  const lost=createCardWriter({client:lostClient,state,saveState:()=>{},now:()=>time});
  await assert.rejects(lost({...payload,deliveryId:'uncertain'}));time+=240001;
  await assert.rejects(lost({...payload,deliveryId:'uncertain'}),error=>error.code==='FEISHU_DELIVERY_UNCERTAIN');
});
test('the management sender prepares images before chunking and carries native image keys into a card',async()=>{
  const f=await fixture();try {
    const cards=[];f.client.im.v1.message={create:async args=>{cards.push(JSON.parse(args.data.content));return {code:0};}};
    const send=createSender({client:f.client,state:f.state,actions:{},saveState:()=>{},getConfig:()=>({}),prepareText:f.media.prepare});
    await send('chat',`![图](${f.file})\n文字`,{kind:'assistant',openId:'user',thread:{hostId:'local'}});
    assert.ok(JSON.stringify(cards).includes('![图](img_fixture_1)'));assert.ok(!JSON.stringify(cards).includes(f.file));
  }finally{await f.close();}
});
