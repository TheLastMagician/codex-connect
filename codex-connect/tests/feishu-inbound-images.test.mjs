import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createInboundImages} from '../src/feishu-inbound-images.mjs';
import {localImageInputs,MAX_INPUT_IMAGE_BYTES} from '../src/image-input.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'codex-inbound-image-'));
test.after(async()=>{assert.ok(folder.startsWith(path.join(os.tmpdir(),'codex-inbound-image-')));await fs.rm(folder,{recursive:true,force:true,maxRetries:30,retryDelay:100});});
function fixture(options={}) {
  const f={calls:[],allowed:true,reports:[],bytes:png};
  f.client={im:{v1:{messageResource:{get:async(payload)=>{f.calls.push(payload);await f.download?.();if(f.error)throw f.error;return {getReadableStream:()=>Readable.from([f.bytes])};}}}}};
  f.prepare=createInboundImages({client:f.client,namespace:'fixture-'+Math.random(),root:path.join(folder,Math.random().toString(36).slice(2)),canRead:()=>f.allowed,report:r=>f.reports.push(r),...options});
  f.message={id:'om_fixture',chatId:'chat-one',openId:'owner',text:'看看图片，别改代码。',images:[{key:'img_fixture'}]};return f;
}
test('plain text performs no download or filesystem preparation; authorized image resources are cached by source',async()=>{
  const f=fixture();assert.deepEqual(await f.prepare({...f.message,images:undefined},{hostId:'local'}),[]);assert.equal(f.calls.length,0);
  const files=await f.prepare(f.message,{hostId:'local'});assert.equal(files.length,1);assert.deepEqual(await fs.readFile(files[0]),png);
  assert.deepEqual(f.calls[0],{path:{message_id:'om_fixture',file_key:'img_fixture'},params:{type:'image'}});
  assert.deepEqual(await f.prepare(f.message,{hostId:'local'}),files);assert.equal(f.calls.length,1);
  const other=await f.prepare({...f.message,chatId:'different-chat'},{hostId:'local'});assert.notEqual(other[0],files[0]);assert.equal(f.calls.length,2);
  const prepared=await localImageInputs(files);assert.deepEqual(prepared.input,[{type:'localImage',path:files[0]}]);assert.equal(prepared.evidence[0].digest.length,64);
});
test('concurrent preparation deduplicates download and cross-bot caches stay separate',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.prepare(f.message,{}),f.prepare(f.message,{})]);assert.deepEqual(a,b);assert.equal(f.calls.length,1);
  const other=fixture();assert.notEqual((await other.prepare(other.message,{}))[0],a[0]);
});
test('authorization is required before network I/O and rechecked while the image downloads',async()=>{
  const f=fixture();f.allowed=false;await assert.rejects(f.prepare(f.message,{}),/授权已撤销/);assert.equal(f.calls.length,0);
  f.allowed=true;f.download=async()=>{f.allowed=false;};await assert.rejects(f.prepare(f.message,{}),/授权已撤销/);
  assert.equal(f.calls.length,1);
});
test('download failures never degrade into a text-only task and do not expose API error bodies',async()=>{
  const f=fixture();f.error=Error('private provider error body');
  await assert.rejects(f.prepare(f.message,{}),e=>e.notSent && e.code==='IMAGE_INPUT_ERROR' && !e.message.includes('private provider'));
  await assert.rejects(f.prepare(f.message,{}),/消息已保留/);assert.equal(f.calls.length,1);
  assert.deepEqual(Object.keys(f.reports[0]).sort(),['at','operation']);
});
test('oversized, non-raster, excess images, traversal keys, and remote targets fail before a native send',async()=>{
  const f=fixture();f.bytes=Buffer.alloc(MAX_INPUT_IMAGE_BYTES+1);await assert.rejects(f.prepare(f.message,{}),/超过 10 MB/);
  const g=fixture();g.bytes=Buffer.from('<svg>not a raster image</svg>');await assert.rejects(g.prepare(g.message,{}),/格式不支持/);
  const h=fixture();await assert.rejects(h.prepare({...h.message,images:Array.from({length:9},()=>({key:'img_fixture'}))},{}),/最多支持 8/);
  await assert.rejects(h.prepare({...h.message,images:[{key:'../../config.json'}]},{}),/资源标识无效/);
  await assert.rejects(h.prepare(h.message,{hostId:'ssh-host'}),/仅支持本机/);assert.equal(h.calls.length,0);
  await assert.rejects(localImageInputs(['https://example.com/image.png']),/路径无效/);
});
