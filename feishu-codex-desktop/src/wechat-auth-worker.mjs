import {setTimeout as delay} from 'node:timers/promises';
import {readJson,writeJson} from './storage.mjs';
import {WechatApi,validateWechatBaseUrl} from './wechat-api.mjs';
import {confirmedWechatAccount} from './wechat-auth.mjs';
import {fileURLToPath} from 'node:url';

export async function pollWechatLogin(id,{makeApi=options=>new WechatApi(options),sleep=delay}={}) {
  while(true) {
    const login=readJson('wechat-login.json',{});
    if(login.id!==id || ['confirmed','cancelled','failed','bound_elsewhere'].includes(login.status)) return;
    if(login.expiresAt<Date.now()) {writeJson('wechat-login.json',{...login,status:'expired'});return;}
    let result;
    try {result=await makeApi({baseUrl:login.baseUrl}).loginStatus(login.qrcode,login.verifyCode);}
    catch {await sleep(2000);continue;}
    const latest=readJson('wechat-login.json',{});
    if(latest.id!==id || latest.status==='cancelled') return;
    let status=result.status;let baseUrl=latest.baseUrl;let error;
    try {
      if(status==='confirmed') {
        writeJson('wechat.json',{...confirmedWechatAccount(result),loginId:id});
        writeJson('wechat-login.json',{id,status:'confirmed',confirmedAt:Date.now()});return;
      }
      if(status==='scaned_but_redirect') {
        if(!result.redirect_host) throw new Error('微信未返回登录跳转地址，请刷新二维码。');
        baseUrl=validateWechatBaseUrl(`https://${result.redirect_host}`);status='scaned';
      }
      if(status==='binded_redirect') {status='bound_elsewhere';error='这个 ClawBot 已有绑定，微信没有返回新的登录凭据。已有连接可继续使用；需要重新绑定时，请在微信解除原连接后刷新二维码。';}
      if(status==='verify_code_blocked') {status='failed';error='验证码尝试次数过多，请刷新二维码后重试。';}
      if(!['wait','scaned','need_verifycode','expired','failed','bound_elsewhere'].includes(status)) status='wait';
    }catch(e){status='failed';error=e.message;}
    const next={...latest,baseUrl,status,...(error?{error}:{})};
    // Never overwrite a newer user-entered verification code while a request is pending.
    if(login.verifyCode && latest.verifyCode===login.verifyCode) delete next.verifyCode;
    writeJson('wechat-login.json',next);
    if(['expired','failed','bound_elsewhere'].includes(status)) return;
    await sleep(1000);
  }
}
const direct=typeof __filename==='string'?process.argv[1]===__filename:process.argv[1]===fileURLToPath(import.meta.url);
if(direct && process.argv[2]) pollWechatLogin(process.argv[2]).catch(()=>{console.error('微信登录暂未完成，请查看插件登录状态。');process.exitCode=1;});
