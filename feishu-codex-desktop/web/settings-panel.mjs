import {App,applyDocumentTheme,applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';
import {VERSION} from '../src/version.mjs';

const app=new App({name:'Codex 连接',version:VERSION});
function apply(context) {
  if(context.theme)applyDocumentTheme(context.theme);
  if(context.styles?.variables)applyHostStyleVariables(context.styles.variables);
  if(context.safeAreaInsets)for(const [edge,value] of Object.entries(context.safeAreaInsets))document.documentElement.style.setProperty('--safe-'+edge,value+'px');
}
app.onhostcontextchanged=apply;app.ontoolresult=()=>{};
app.onerror=()=>{const el=document.getElementById('desktop-status');if(el)el.textContent='面板连接暂不可用，请重新打开';};
const ready=app.connect().then(()=>{const context=app.getHostContext();if(context)apply(context);});
globalThis.codexConnectPanel={ready,request:async(route,method,value)=>{
  await ready;
  const result=await app.callServerTool({name:'settings_request',arguments:{route,method,...(value===undefined?{}:{value})}});
  if(result.isError)throw new Error(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'配置操作未完成');
  return result.structuredContent;
}};
