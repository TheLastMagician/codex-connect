import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {parse} from 'smol-toml';

export const home=()=>process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
export function readConfig(directory=home()) {
  try{return parse(fs.readFileSync(path.join(directory,'config.toml'),'utf8').replace(/^\uFEFF/,''));}
  catch{throw new Error('无法读取 Codex 配置，请检查 config.toml 的格式。');}
}
export function publicUrl(value) {
  try{const url=new URL(value);return url.origin+url.pathname;}catch{return '';}
}
export function providerList(config) {
  const items=[{id:'openai',name:'自己的 ChatGPT / OpenAI 账号',baseUrl:'OpenAI',wireApi:'responses',authentication:'已有 Codex 登录'}];
  for(const [id,p] of Object.entries(config.model_providers||{})) {
    if(id==='openai'||!p||typeof p!=='object'||!p.base_url)continue;
    items.push({id,name:p.name||id,baseUrl:publicUrl(p.base_url),wireApi:p.wire_api||'responses',
      authentication:p.requires_openai_auth?'Codex 登录':p.env_key?'环境变量':p.experimental_bearer_token?'已配置密钥':p.auth?'凭据助手':'无密钥',
      ...(p.model?{configurationNote:'供应商表内的 model 不会设置默认模型；新建时以面板选择为准。'}:{})});
  }
  return {defaultProvider:config.model_provider||'openai',defaultModel:config.model||null,providers:items};
}
export function requireSelection(config,providerId,model) {
  if(!providerList(config).providers.some(p=>p.id===providerId))throw new Error('供应商不存在，请刷新配置。');
  if(typeof model!=='string'||!model.trim()||model.length>160||/[\r\n\0]/.test(model))throw new Error('请选择有效的模型 ID。');
  const p=config.model_providers?.[providerId];
  if(p?.wire_api&&p.wire_api!=='responses')throw new Error('这个供应商没有配置 Responses API。');
  return {modelProvider:providerId,model:model.trim()};
}
export function launcherDefaults(config) {
  if(providerList(config).providers.some(p=>p.id==='custom'))return {providerId:'custom',model:'qwen3.8-27b',effort:'xhigh'};
  return {providerId:config.model_provider||'openai',model:config.model||'gpt-6-luna',effort:config.model_reasoning_effort||'low'};
}
export async function discoverModels(config,providerId,{fetchImpl=fetch,env=process.env,client}={}) {
  requireSelection(config,providerId,'discovery');
  if(providerId==='openai') {
    const result=await client.request('model/list',{includeHidden:false,limit:100});
    const models=result.data.filter(m=>m.description!=='用户自定义供应商模型');
    return {models:models.map(m=>({id:m.model,name:m.displayName||m.model,efforts:m.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[],defaultEffort:m.defaultReasoningEffort})),source:'Codex 本机 OpenAI 模型目录'};
  }
  const p=config.model_providers[providerId];
  if(p.auth||p.requires_openai_auth)throw new Error('该供应商使用登录或凭据助手，暂不自动读取模型；可以手动填写模型 ID。');
  const token=p.env_key?env[p.env_key]:p.experimental_bearer_token;
  if(p.env_key&&!token)throw new Error('供应商的密钥环境变量在当前 Codex 进程中不可用。');
  const url=new URL(p.base_url.replace(/\/$/,'')+'/models');
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('供应商地址无效。');
  const headers={...p.http_headers};
  for(const [key,name] of Object.entries(p.env_http_headers||{}))if(env[name])headers[key]=env[name];
  if(token)headers.Authorization=`Bearer ${token}`;
  let response;
  try{response=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Error('模型目录请求失败，请检查供应商地址和网络。');}
  if(!response.ok)throw new Error(`供应商模型目录返回 HTTP ${response.status}，可以手动填写模型 ID。`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new Error('模型目录过大，已停止读取。');chunks.push(chunk);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('供应商返回的模型目录不是 JSON。');}
  const models=[...new Set((data.data||[]).map(m=>m.id).filter(id=>typeof id==='string'&&id.length<=160&&!/[\r\n\0]/.test(id)))];
  return {models:models.map(id=>({id,name:id})),source:`供应商目录：${publicUrl(url.href)}`};
}
