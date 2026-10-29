import {readJson,writeJson} from './storage.mjs';
export function readWechatAccount() {
  const account=readJson('wechat.json',{});
  const revoked=readJson('wechat-revoked.json',{loginIds:[]});
  return account.loginId && revoked.loginIds.includes(account.loginId)?{...account,enabled:false}:account;
}
export function revokeWechatLogin(loginId,accountLoginId) {
  const previous=readJson('wechat-revoked.json',{loginIds:[]});
  writeJson('wechat-revoked.json',{loginIds:[...new Set([...previous.loginIds,loginId,accountLoginId].filter(Boolean))].slice(-30)});
}
