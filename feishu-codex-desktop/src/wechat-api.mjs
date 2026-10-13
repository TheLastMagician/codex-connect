import {randomBytes,randomUUID} from 'node:crypto';
import {VERSION} from './version.mjs';

export const WECHAT_BASE_URL='https://ilinkai.weixin.qq.com';
// The public iLink bot protocol uses Tencent hosts for login and authenticated APIs.
export function validateWechatBaseUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash ||
    (url.hostname!=='weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com')) || !['','/'].includes(url.pathname)) {
    throw new Error('微信返回了不受支持的服务地址，请重新扫码或检查客户端版本。');
  }
  return url.origin;
}
export class WechatApiError extends Error {
  constructor(code) {super(`微信接口请求失败（${code}）`);this.code=code;}
}
export class WechatApi {
  constructor({baseUrl=WECHAT_BASE_URL,token,fetchImpl=fetch}={}) {
    this.baseUrl=validateWechatBaseUrl(baseUrl);this.token=token;this.fetch=fetchImpl;
  }
  async request(endpoint,{body,timeoutMs=15000,signal,auth=true}={}) {
    const [major,minor,patch]=VERSION.split('.').map(Number);
    const headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':String((major<<16)|(minor<<8)|patch)};
    const post=body!==undefined;
    if(post) Object.assign(headers,{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token',
      'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      ...(auth && this.token?{Authorization:`Bearer ${this.token}`}:{})});
    const timeout=AbortSignal.timeout(timeoutMs);
    try {
      const result=await this.fetch(new URL(endpoint+'',this.baseUrl+'/'),{method:post?'POST':'GET',headers,
        ...(post?{body:JSON.stringify(body)}:{}),redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!result.ok) throw new WechatApiError(`HTTP ${result.status}`);
      const raw=await result.text();if(raw.length>4*1024*1024) throw new WechatApiError('响应过大');
      const value=JSON.parse(raw);
      const code=[value.ret,value.errcode].find(c=>typeof c==='number' && c!==0);
      if(code!==undefined) throw new WechatApiError(code);
      return value;
    }catch(error) {
      if(error instanceof WechatApiError) throw error;
      if(signal?.aborted) throw new WechatApiError('已取消');
      throw new WechatApiError(timeout.aborted?'连接超时':'网络或响应异常');
    }
  }
  bot(endpoint,body={},options={}) {
    if(!this.token) throw new Error('微信尚未登录，请先扫码。');
    return this.request(`ilink/bot/${endpoint}`,{...options,body:{...body,base_info:{channel_version:VERSION,bot_agent:`CodexDesktopBridge/${VERSION}`}}});
  }
  qrcode(tokens=[]) {return this.request('ilink/bot/get_bot_qrcode?bot_type=3',{auth:false,body:{local_token_list:tokens.slice(0,10)}});}
  loginStatus(qrcode,verifyCode,options={}) {
    const query=new URLSearchParams({qrcode});if(verifyCode) query.set('verify_code',verifyCode);
    return this.request(`ilink/bot/get_qrcode_status?${query}`,{timeoutMs:35000,...options});
  }
  updates(cursor='',options={}) {return this.bot('getupdates',{get_updates_buf:cursor},{timeoutMs:35000,...options});}
  sendText(userId,text,contextToken,options={}) {
    if(!contextToken) throw new Error('尚未收到微信消息。请先在微信 ClawBot 中发送 /help。');
    return this.bot('sendmessage',{msg:{from_user_id:'',to_user_id:userId,client_id:`codex-${randomUUID()}`,
      message_type:2,message_state:2,context_token:contextToken,item_list:[{type:1,text_item:{text}}]}},options);
  }
}
