import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import QRCode from 'qrcode';
import {dataDir,readJson,writeJson,secureDirectory} from './storage.mjs';
import {WechatApi,WECHAT_BASE_URL,validateWechatBaseUrl} from './wechat-api.mjs';
import {readWechatAccount,revokeWechatLogin} from './wechat-storage.mjs';

const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
export function wechatLoginStatus() {
  const login=readJson('wechat-login.json',{});const account=readWechatAccount();
  const revoked=readJson('wechat-revoked.json',{loginIds:[]}).loginIds.includes(login.id);
  const status=revoked?'cancelled':login.expiresAt<Date.now() && !['confirmed','cancelled','failed','bound_elsewhere'].includes(login.status)?'expired':login.status||'not_started';
  return {status,configured:!!(account.enabled && account.token && account.botId && account.ownerUserId),
    ...(login.id?{loginId:login.id,expiresAt:login.expiresAt}:{}),
    ...(login.error?{error:login.error}:{}),
    ...(status==='need_verifycode'?{note:'请输入手机微信显示的配对验证码，调用 wechat_verify_code。'}:{}),
    ...(status==='wait' || status==='scaned'?{qrPath:login.qrPath,note:'使用微信扫一扫，然后在手机上确认。'}:{})};
}
export async function beginWechatLogin({refresh=false,api=new WechatApi(),launch=true}={}) {
  secureDirectory();const existing=wechatLoginStatus();
  if(!refresh && ['wait','scaned','need_verifycode'].includes(existing.status)) return existing;
  const account=readJson('wechat.json',{});
  if(!refresh && existing.configured) return {status:'confirmed',configured:true,note:'微信已登录。要换绑账号，请显式刷新登录二维码。'};
  const result=await api.qrcode(account.token?[account.token]:[]);
  if(typeof result.qrcode!=='string' || !result.qrcode || typeof result.qrcode_img_content!=='string' || !result.qrcode_img_content || result.qrcode_img_content.length>8192) throw new Error('微信没有返回有效的登录二维码。');
  const id=randomUUID();const qrPath=path.join(dataDir,`wechat-login-${id}.png`);
  await QRCode.toFile(qrPath,result.qrcode_img_content,{width:360,margin:4,errorCorrectionLevel:'M'});
  fs.chmodSync(qrPath,0o600);
  writeJson('wechat-login.json',{id,qrcode:result.qrcode,qrPath,baseUrl:WECHAT_BASE_URL,
    startedAt:Date.now(),expiresAt:Date.now()+5*60*1000,status:'wait'});
  if(launch) {
    const worker=path.join(directory,typeof __dirname==='string'?'wechat-auth-worker.cjs':'wechat-auth-worker.mjs');
    const log=fs.openSync(path.join(dataDir,'wechat-login.log'),'a',0o600);
    try {
      const child=spawn(process.execPath,[worker,id],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:process.env});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    }finally{fs.closeSync(log);}
  }
  return wechatLoginStatus();
}
export function submitWechatVerifyCode(code) {
  if(!/^[0-9A-Za-z-]{4,16}$/.test(code)) throw new Error('请输入手机微信显示的有效配对验证码。');
  const login=readJson('wechat-login.json',{});
  if(login.status!=='need_verifycode' || login.expiresAt<Date.now()) throw new Error('当前没有等待验证码的微信登录，请重新扫码。');
  writeJson('wechat-login.json',{...login,verifyCode:code});return {submitted:true,note:'验证码已提交，请稍后查看 wechat_login_status。'};
}
export function confirmedWechatAccount(response) {
  if([response.bot_token,response.ilink_bot_id,response.ilink_user_id].some(v=>typeof v!=='string' || !v.trim())) throw new Error('微信登录缺少凭据或扫码用户身份，未启用控制。');
  return {enabled:true,token:response.bot_token,botId:response.ilink_bot_id,ownerUserId:response.ilink_user_id,
    baseUrl:validateWechatBaseUrl(response.baseurl||WECHAT_BASE_URL),connectedAt:Date.now()};
}
export function disconnectWechat() {
  const login=readJson('wechat-login.json',{});const account=readJson('wechat.json',{});
  revokeWechatLogin(login.id,account.loginId);writeJson('wechat-login.json',{id:login.id,status:'cancelled'});
  try{fs.unlinkSync(path.join(dataDir,'wechat.json'));}catch(e){if(e.code!=='ENOENT') throw e;}
  return {disconnected:true,note:'微信通道已断开，飞书通道保持运行。'};
}
