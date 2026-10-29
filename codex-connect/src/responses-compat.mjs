import http from 'node:http';
import https from 'node:https';
import {pipeline} from 'node:stream/promises';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';

const MAX_BODY=64*1024*1024;
const HOP_HEADERS=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const NAMES=new Set(['create_thread','send_message_to_thread']);
function decodeXml(text) {return text.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');}

// Native desktop delegation is user input, not the result of a model tool call.
// Keep all real tool outputs, including outputs using a valid call_id, intact.
export function normalizeDelegations(body) {
  if(!body || !Array.isArray(body.input))return {body,converted:0};
  let converted=0;
  const input=body.input.map(item=>{
    if(item?.type!=='function_call_output' || item.call_id!=null || item.namespace!=='codex_app' ||
      !NAMES.has(item.name) || typeof item.output!=='string')return item;
    const match=/^<codex_delegation>\s*<source_thread_id>[^<>]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
    if(!match)return item;
    converted++;
    return {type:'message',role:'user',content:[{type:'input_text',text:decodeXml(match[1])}]};
  });
  return {body:converted?{...body,input}:body,converted};
}
function headersWithoutHop(headers) {
  const excluded=new Set([...HOP_HEADERS,...String(headers.connection||'').toLowerCase().split(',').map(x=>x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!excluded.has(key.toLowerCase())));
}
function normalizeBytes(bytes,encoding) {
  let decoded=bytes;
  if(encoding==='gzip')decoded=gunzipSync(bytes,{maxOutputLength:MAX_BODY});
  else if(encoding==='deflate')decoded=inflateSync(bytes,{maxOutputLength:MAX_BODY});
  else if(encoding==='br')decoded=brotliDecompressSync(bytes,{maxOutputLength:MAX_BODY});
  else if(encoding && encoding!=='identity')throw Object.assign(new Error('Unsupported request compression'),{status:415});
  let body;try{body=JSON.parse(decoded.toString('utf8'));}catch{return {bytes,converted:0};}
  const result=normalizeDelegations(body);
  return result.converted?{bytes:Buffer.from(JSON.stringify(result.body)),converted:result.converted}:{bytes,converted:0};
}
export function createResponsesCompatServer({getRoutes,instanceId,onConverted=()=>{},allowTestHttp=false}) {
  return http.createServer(async(request,response)=>{
    const fail=(status,message)=>{
      if(response.headersSent){response.destroy();return;}
      response.writeHead(status,{'Content-Type':'application/json'});
      response.end(JSON.stringify({error:{message,type:'codex_connect_compat_error'}}));
    };
    let upstream;
    try {
      const url=new URL(request.url,'http://127.0.0.1');
      if(request.method==='GET' && url.pathname===`/health/${instanceId}`) {
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({service:'codex-connect-responses',instanceId}));return;
      }
      const route=getRoutes().find(r=>url.pathname===`/${r.token}/responses` || url.pathname===`/${r.token}/responses/compact`);
      if(request.method!=='POST' || !route){fail(404,'Unknown model endpoint');return;}
      const base=new URL(route.upstream);
      if(base.username || base.password || base.hash || base.search ||
        (base.protocol!=='https:' && !(allowTestHttp && base.protocol==='http:' && base.hostname==='127.0.0.1')))
        throw new Error('Invalid upstream');
      const target=new URL(url.pathname.endsWith('/compact')?'responses/compact':'responses',base.href.replace(/\/?$/,'/'));
      target.search=url.search;
      const chunks=[];let length=0;
      for await(const chunk of request) {
        length+=chunk.length;if(length>MAX_BODY){fail(413,'Model request is too large');return;}chunks.push(chunk);
      }
      const normalized=normalizeBytes(Buffer.concat(chunks),String(request.headers['content-encoding']||''));
      const headers=headersWithoutHop(request.headers);headers.host=target.host;headers['content-length']=String(normalized.bytes.length);
      if(normalized.converted)delete headers['content-encoding'];
      // Forward once. Retrying a streamed model request here can duplicate work.
      upstream=(target.protocol==='https:'?https:http).request(target,{method:'POST',headers});
      const cancel=()=>upstream.destroy();response.once('close',cancel);
      const result=new Promise((resolve,reject)=>{upstream.once('response',resolve);upstream.once('error',reject);});
      upstream.end(normalized.bytes);
      const reply=await result;
      response.writeHead(reply.statusCode,headersWithoutHop(reply.headers));
      if(normalized.converted){try{onConverted(normalized.converted);}catch{}}
      try{await pipeline(reply,response);}finally{response.off('close',cancel);}
    }catch(error){upstream?.destroy();fail(error.status||502,'本机模型兼容层未能完成请求；不会自动重试，请检查原供应商连接。');}
  });
}
