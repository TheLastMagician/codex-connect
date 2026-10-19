import fs from 'node:fs';
import path from 'node:path';
import {home} from './providers.mjs';
import {spawn} from 'node:child_process';

export async function compatibleWithInstalledCli(file,{env=process.env,run}={}) {
  if(process.platform!=='win32')return true;
  const shim=path.join(env.APPDATA||path.join(env.USERPROFILE||'','AppData','Roaming'),'npm','node_modules','@openai','codex','bin','codex.js');
  if(!fs.existsSync(shim))return true;
  if(run)return run(shim,file);
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[shim,'app-server','-c','model_catalog_json='+JSON.stringify(file)],{env,windowsHide:true,stdio:['pipe','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();resolve(false);},15000);
    child.once('error',()=>{clearTimeout(timer);resolve(false);});
    child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});
    child.stdin.on('error',()=>{});child.stdin.end();
  });
}

// Keep every existing model; catalog metadata is separate from provider routing.
export function buildCatalog({source,models}) {
  if(!Array.isArray(source?.models)||source.models.length===0)throw new Error('没有找到当前版本的 Codex 模型目录。');
  const template=source.models.find(m=>m.slug==='gpt-6-luna')||source.models[0];
  const all=new Map(source.models.map(m=>[m.slug,m]));
  for(const id of models) {
    if(all.has(id))continue;
    const item=structuredClone(template);
    Object.assign(item,{slug:id,display_name:id,description:'用户自定义供应商模型',
      default_reasoning_level:'xhigh',supported_reasoning_levels:['none','minimal','low','medium','high','xhigh','max','ultra'].map(effort=>({effort,description:effort==='none'?'不额外指定推理预算':`请求 ${effort} 强度，实际支持由供应商决定`})),
      visibility:'list',supported_in_api:true,priority:100,additional_speed_tiers:[],service_tiers:[],
      available_access_programs:{cyber:['standard']},availability_nux:null,upgrade:null,model_messages:null,
      base_instructions:'You are a coding assistant. Follow the user instructions, inspect the workspace before editing, and use the available tools accurately.',
      default_reasoning_summary:'none',support_verbosity:false,default_verbosity:'low',
      apply_patch_tool_type:null,web_search_tool_type:'text_and_image',supports_search_tool:false,
      supports_experimental_context:false,supports_image_detail_original:false,input_modalities:['text'],
      context_window:32768,max_context_window:32768,use_responses_lite:false,
      experimental_supported_tools:[],supports_reasoning_effort_updates:true,node_repl_disabled:true,tool_mode:'classic'});
    for(const field of ['multi_agent_version','multi_agent_reasoning_effort','comp_hash'])delete item[field];
    all.set(id,item);
  }
  return {models:[...all.values()]};
}
export function prepareCatalog(config,models,directory=home()) {
  const sourcePath=config.model_catalog_json||path.join(directory,'models_cache.json');
  let source;try{source=JSON.parse(fs.readFileSync(sourcePath,'utf8'));}catch{throw new Error('当前版本的模型目录不可用，无法准备原生菜单。');}
  const catalog=buildCatalog({source,models});
  const folder=path.join(directory,'model-switcher');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const file=path.join(folder,'models.json');fs.writeFileSync(file,JSON.stringify(catalog),{mode:0o600});
  return file;
}
