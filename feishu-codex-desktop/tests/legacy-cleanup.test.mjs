import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {clearLegacySessionData,removeLegacyAssistantData} from '../src/legacy-cleanup.mjs';

test('legacy settings and histories are removed only from bridge profiles, preserving connections and task tracking',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-connect-cleanup-'));
  const names=['state.json','feishu-state-00000000-0000-0000-0000-000000000001.json','wechat-state-1234567890abcdef12345678.json'];
  const state={sessions:{s:{openId:'owner',chatId:'chat',selected:{id:'selected'},modelOverrides:{'local:selected':{model:'native-model'}},mode:'assistant',routingVersion:3,assistantHistory:[{content:'private history'}]}},seen:{event:1},watches:{r:{receiptState:'uncertain',clientUserMessageId:'persisted-id'}},contexts:{owner:{token:'context-token'}},fixedQueue:{pending:[{text:'queued task'}]}};
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  try {
    write('assistant.json',{apiKey:'legacy-private-key'});for(const name of names)write(name,state);
    write('config.json',{appSecret:'feishu-secret'});write('wechat.json',{token:'wechat-token'});write('unrelated.json',state);
    assert.deepEqual(removeLegacyAssistantData(root,write),{configRemoved:true,profilesUpdated:3});
    const expected=structuredClone(state);clearLegacySessionData(expected);
    for(const name of names)assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,name),'utf8')),expected);
    assert.equal(fs.existsSync(path.join(root,'assistant.json')),false);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'unrelated.json'),'utf8')),state);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),{appSecret:'feishu-secret'});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'wechat.json'),'utf8')),{token:'wechat-token'});
    assert.deepEqual(removeLegacyAssistantData(root,write),{configRemoved:false,profilesUpdated:0});
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-connect-cleanup-'));fs.rmSync(root,{recursive:true,force:true});}
});
