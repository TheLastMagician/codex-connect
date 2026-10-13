import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-wechat-auth-test-'));
process.env.FEISHU_CODEX_DATA_DIR=folder;
const {beginWechatLogin,wechatLoginStatus,submitWechatVerifyCode,disconnectWechat}=await import('../src/wechat-auth.mjs');
const {readJson,writeJson}=await import('../src/storage.mjs');
const {pollWechatLogin}=await import('../src/wechat-auth-worker.mjs');
test.after(()=>{
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'feishu-wechat-auth-test-'));
  fs.rmSync(folder,{force:true,recursive:true});
});

test('QR login is persistent, prompts for verification, binds only confirmed owner and hides credentials',async()=>{
  const result=await beginWechatLogin({launch:false,api:{qrcode:async()=>({qrcode:'test-qr',qrcode_img_content:'https://weixin.qq.com/test-login'})}});
  assert.equal(result.status,'wait');assert.ok(fs.existsSync(result.qrPath));
  assert.deepEqual(fs.readFileSync(result.qrPath).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  let step=0;
  await pollWechatLogin(result.loginId,{makeApi:()=>({loginStatus:async(qr,code)=>{
    assert.equal(qr,'test-qr');
    if(step++===0)return {status:'need_verifycode'};
    assert.equal(code,'1234');return {status:'confirmed',bot_token:'private-token',ilink_bot_id:'test-bot',ilink_user_id:'test-owner',baseurl:'https://ilinkai.weixin.qq.com'};
  }}),sleep:async()=>{assert.equal(wechatLoginStatus().status,'need_verifycode');submitWechatVerifyCode('1234');}});
  assert.equal(wechatLoginStatus().configured,true);assert.equal(readJson('wechat.json',{}).ownerUserId,'test-owner');
  assert.ok(!JSON.stringify(wechatLoginStatus()).includes('private-token'));
  assert.ok(!fs.readFileSync(path.join(folder,'wechat-login.json'),'utf8').includes('1234'));
  writeJson('config.json',{appId:'preserved-feishu',allowedOpenIds:['existing-owner']});
  disconnectWechat();assert.equal(wechatLoginStatus().configured,false);assert.equal(readJson('config.json',{}).appId,'preserved-feishu');
  // A confirmation arriving concurrently with disconnect cannot restore revoked access.
  writeJson('wechat.json',{enabled:true,token:'late-token',botId:'test-bot',ownerUserId:'test-owner',loginId:result.loginId});
  writeJson('wechat-login.json',{id:result.loginId,status:'confirmed'});
  assert.equal(wechatLoginStatus().configured,false);assert.equal(wechatLoginStatus().status,'cancelled');
});
test('expired QR refresh, blocked verification and unsafe redirects never enable an account',async()=>{
  writeJson('wechat-login.json',{id:'expired',status:'wait',expiresAt:Date.now()-1});assert.equal(wechatLoginStatus().status,'expired');
  const q=()=>({qrcode:async()=>({qrcode:'test-qr',qrcode_img_content:'https://weixin.qq.com/test-login'})});
  const login=await beginWechatLogin({launch:false,api:q()});
  await pollWechatLogin(login.loginId,{makeApi:()=>({loginStatus:async()=>({status:'scaned_but_redirect',redirect_host:'evil.test'})}),sleep:async()=>{}});
  assert.equal(wechatLoginStatus().status,'failed');assert.equal(wechatLoginStatus().configured,false);
  const next=await beginWechatLogin({refresh:true,launch:false,api:q()});
  await pollWechatLogin(next.loginId,{makeApi:()=>({loginStatus:async()=>({status:'verify_code_blocked'})}),sleep:async()=>{}});
  assert.equal(wechatLoginStatus().status,'failed');
  assert.throws(()=>submitWechatVerifyCode('1234'),/没有等待验证码/);
});
