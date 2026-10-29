import {readJson} from './storage.mjs';

export const SETTINGS_URI='ui://codex-connect/settings.html';
export const SETTINGS_REQUEST_SCHEMA={type:'object',properties:{route:{type:'string',maxLength:160},method:{type:'string',enum:['GET','POST','PUT','DELETE']},value:{type:'object'}},required:['route'],additionalProperties:false};
const routes=[['GET',/^(state|catalog|wechat\/qr)$/],['POST',/^(bots|bots\/(default|[0-9a-f-]{36})\/users|wechat\/(login|verify|disconnect|enabled)|autostart|resume)$/],
  ['PUT',/^bots$/],['DELETE',/^bots\/[0-9a-f-]{36}$/]];

// Reuse the private, authenticated configuration service. Its address, cookie
// and CSRF token never leave this backend; the App communicates only over MCP.
export async function settingsRequest(input,{ready,read=()=>readJson('dashboard.json',{}),fetcher=fetch}={}) {
  if(!input || Object.keys(input).some(k=>!['route','method','value'].includes(k)))throw new Error('配置操作无效');
  const {route,method='GET',value}=input;
  if(typeof route!=='string' || !routes.some(([verb,pattern])=>verb===method && pattern.test(route)) ||
    (method==='GET' && value!==undefined) || (method!=='GET' && (!value || typeof value!=='object' || Array.isArray(value))))throw new Error('不支持这个配置操作');
  const body=value===undefined?undefined:JSON.stringify(value);
  if(body && Buffer.byteLength(body)>65536)throw new Error('配置内容过长');
  await ready();const saved=read();
  if(!Number.isInteger(saved.port) || saved.port<1 || saved.port>65535 || !/^[0-9a-f]{64}$/.test(saved.token||'') || !/^[0-9a-f]{64}$/.test(saved.csrf||''))throw new Error('配置服务尚未就绪，请重新打开面板');
  const origin=`http://127.0.0.1:${saved.port}`;
  let response;
  try {response=await fetcher(`${origin}/api/${route}`,{method,redirect:'error',signal:AbortSignal.timeout(25000),
    headers:{Cookie:`codex_connect_${saved.port}=${saved.token}`,Origin:origin,'Content-Type':'application/json','X-Codex-Csrf':saved.csrf},...(body?{body}:{})});}
  catch{throw new Error('本机配置服务连接暂不可用，请刷新状态；保存结果不确定时先检查配置，避免重复操作');}
  if(route==='wechat/qr' && response.ok) {
    if(!response.headers.get('content-type')?.startsWith('image/png'))throw new Error('二维码内容无效，请刷新二维码');
    const data=Buffer.from(await response.arrayBuffer());if(data.length>1048576)throw new Error('二维码内容过大');
    return {dataUrl:'data:image/png;base64,'+data.toString('base64')};
  }
  const result=await response.json();if(!response.ok)throw new Error(result.error||'配置操作未完成');return result;
}

export const SETTINGS_READ_OUTPUT={type:'object',properties:{schema:{type:'object'},values:{type:'object'},layout:{type:'array',items:{type:'object'}}},required:['schema','values']};
export const SETTINGS_UPDATE_INPUT={type:'object',properties:{set:{type:'object',properties:{autostart:{type:'boolean'}},required:['autostart'],additionalProperties:false}},required:['set'],additionalProperties:false};
export function connectionSettings(enabled) {
  return {schema:{type:'object',properties:{autostart:{type:'boolean',title:'桌面会话启动时自动连接',description:'首次启用后，在 Codex 设置 → 钩子中审阅并信任。'}},required:['autostart']},values:{autostart:enabled},
    layout:[{kind:'group',title:'飞书与微信',items:[{kind:'tool',tool:'open_settings',description:'管理机器人、绑定会话、扫码连接微信及批准账号。'}]},
      {kind:'group',title:'自动连接',items:[{kind:'property',property:'autostart'}]}]};
}
