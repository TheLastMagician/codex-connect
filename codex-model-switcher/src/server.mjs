import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {LauncherService} from './service.mjs';
import {readConfig,home} from './providers.mjs';
import {prepareCatalog,compatibleWithInstalledCli} from './catalog.mjs';
import {withAppServer} from './app-server.mjs';
import {NativeSettings,SETTINGS_READ_OUTPUT,SETTINGS_UPDATE_INPUT} from './settings.mjs';
import {ScheduleStore} from './schedules.mjs';
import {SchedulerRuntime} from './scheduler-runtime.mjs';

async function main() {
const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
const icons=[...['light','dark'].map(theme=>({
  src:'data:image/svg+xml;base64,'+fs.readFileSync(path.join(directory,'..','assets',`navigation-${theme}.svg`)).toString('base64'),
  mimeType:'image/svg+xml',sizes:['any'],theme
})),{src:'data:image/svg+xml;base64,'+fs.readFileSync(path.join(directory,'..','assets','icon.svg')).toString('base64'),mimeType:'image/svg+xml',sizes:['any']}];
const service=new LauncherService();
const settings=new NativeSettings(service);
const schedules=new ScheduleStore(),scheduler=new SchedulerRuntime(path.join(directory,'scheduler.cjs'));
try{if(schedules.jobs().some(j=>j.status==='ACTIVE'))scheduler.ensure().catch(()=>{});}catch{/* Schedule errors must not disable model tools. */}
const URI='ui://codex-model-switcher/panel.html';
const empty={type:'object',properties:{},additionalProperties:false};
const tools=[
  {name:'open_schedule_panel',title:'定时任务管理',description:'打开插件定时任务管理页，为每个任务选择供应商、模型和思考强度。默认填入千问，支持其他已配置供应商。',inputSchema:empty,icons,annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:URI}}},
  {name:'list_model_schedules',description:'读取本机插件定时任务、下次执行时间和最近运行记录。',inputSchema:empty,annotations:{readOnlyHint:true}},
  {name:'save_model_schedule',description:'用户明确要求后，在本机创建或更新独立每天或每周定时任务，向指定已有会话发送任务提示词。默认 custom / qwen3.8-27b / xhigh，按北京时间执行。启用时安装隐藏后台服务和当前用户登录自启动；不修改原生定时任务或模型目录。相同任务编辑和重试必须复用 ID。',inputSchema:{type:'object',properties:{id:{type:'string'},name:{type:'string'},threadRef:{type:'string'},prompt:{type:'string'},time:{type:'string',description:'北京时间 HH:mm'},frequency:{type:'string',enum:['daily','weekly'],description:'新任务默认每天；编辑时省略则保留原频率'},weekdays:{type:'array',items:{type:'integer',minimum:1,maximum:7},minItems:1,maxItems:7,uniqueItems:true,description:'每周执行星期，1=周一，7=周日；每周计划必须选择至少一天'},status:{type:'string',enum:['ACTIVE','PAUSED']},providerId:{type:'string',default:'custom'},model:{type:'string',default:'qwen3.8-27b'},effort:{type:'string',enum:['none','minimal','low','medium','high','xhigh','max','ultra'],default:'xhigh'}},required:['id','name','threadRef','prompt','time','status'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'set_model_schedule_status',description:'用户要求后暂停或启用指定插件定时任务。启用会启动本机隐藏后台服务。',inputSchema:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['ACTIVE','PAUSED']}},required:['id','status'],additionalProperties:false},annotations:{readOnlyHint:false,idempotentHint:true}},
  {name:'acknowledge_model_schedule_run',description:'仅在用户已检查原会话并明确确认后，解除结果未知的定时运行阻塞。本次不会重发，只允许后续计划继续。',inputSchema:{type:'object',properties:{id:{type:'string'},day:{type:'string'}},required:['id','day'],additionalProperties:false},annotations:{readOnlyHint:false,idempotentHint:true}},
  {name:'stop_model_scheduler',title:'暂停全部并停止后台服务',description:'用户明确要求后，暂停全部插件定时任务，停用本机登录自启动并请求后台服务退出。已发送的会话回合继续执行，不会中断。',inputSchema:empty,annotations:{readOnlyHint:false,idempotentHint:true}},
  {name:'read_launcher_settings',description:'读取插件详情页的原生配置控件、当前设置和操作按钮。',inputSchema:empty,outputSchema:SETTINGS_READ_OUTPUT,annotations:{readOnlyHint:true}},
  {name:'update_launcher_settings',description:'保存插件原生配置页中改变的字段；不修改 Codex 默认配置，不创建会话。',inputSchema:SETTINGS_UPDATE_INPUT,outputSchema:{type:'object',properties:{values:{type:'object'}},required:['values']},annotations:{readOnlyHint:false}},
  {name:'launch_from_settings',title:'按以上配置新建会话',description:'用户点击原生设置页的新建按钮或明确要求时，使用已保存的插件设置新建并打开会话；不发送消息。',inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'modify_from_settings',title:'修改已有会话模型',description:'用户点击修改按钮或明确要求时，按插件设置修改指定已有会话的模型和强度。默认 custom / qwen3.8-27b / xhigh；保留上下文，不发送消息、不改供应商或定时任务。',inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'list_existing_threads',description:'分页读取指定供应商的本机已有会话，供用户选择。',inputSchema:{type:'object',properties:{providerId:{type:'string',default:'custom'},cursor:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'modify_existing_thread',title:'修改已有会话模型',description:'用户明确要求后修改指定会话的模型和强度，默认 custom / qwen3.8-27b / xhigh。先核对持久化供应商，再等待桌面设置读回；不新建会话、不发送消息、不切换供应商、不改定时任务。',inputSchema:{type:'object',properties:{threadRef:{type:'string',description:'用户选择或提供的会话 ID / codex://threads/ 链接'},providerId:{type:'string',default:'custom'},model:{type:'string',default:'qwen3.8-27b'},effort:{type:'string',enum:['none','minimal','low','medium','high','xhigh','max','ultra'],default:'xhigh'}},required:['threadRef'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'open_model_panel',title:'供应商与模型',description:'打开供应商与模型面板。选择已配置的供应商和模型，新建真实 Codex 桌面会话。',inputSchema:empty,icons,
    annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'global'}]}}},
  {name:'open_thread_model_panel',title:'供应商与模型',description:'在当前会话旁打开面板，新建会话或修改已有会话模型。',inputSchema:empty,icons,
    annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'thread'}]}}},
  {name:'list_provider_models',description:'读取所选供应商的模型目录；不会发送推理请求。',inputSchema:{type:'object',properties:{providerId:{type:'string'}},required:['providerId'],additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app','model']}}},
  {name:'create_provider_thread',description:'仅在用户要求新建时，使用所选供应商、模型和 Codex 已有项目创建真实会话并打开。projectId 和 cwd 必须来自 open_model_panel 返回的 projects。没有首条消息，不开始推理。',
    inputSchema:{type:'object',properties:{operationId:{type:'string'},providerId:{type:'string'},model:{type:'string'},projectId:{type:'string'},cwd:{type:'string'},title:{type:'string'},effort:{type:'string',enum:['none','minimal','low','medium','high','xhigh','max','ultra']}},required:['operationId','providerId','model','projectId','cwd','title'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},_meta:{ui:{visibility:['app','model']}}},
  {name:'complete_provider_thread',description:'重新打开已经创建的会话并确认模型，避免重复创建。',inputSchema:{type:'object',properties:{operationId:{type:'string'}},required:['operationId'],additionalProperties:false},annotations:{readOnlyHint:false,idempotentHint:true},_meta:{ui:{visibility:['app','model']}}},
  {name:'prepare_native_models',description:'仅当用户要求接入原生模型菜单时，保留现有模型并加入选定模型 ID，备份配置后设置 model_catalog_json。可能需要重新启动桌面一次。',
    inputSchema:{type:'object',properties:{models:{type:'array',items:{type:'string'},minItems:1,maxItems:30}},required:['models'],additionalProperties:false},annotations:{readOnlyHint:false},_meta:{ui:{visibility:['app','model']}}},
  {name:'open_launcher_browser',description:'取得可在 Codex 浏览器面板打开的本机启动器链接，作为 MCP App 入口不可用时的备用入口。',inputSchema:empty,annotations:{readOnlyHint:true}}
];
async function nativeModels(models) {
  if(!Array.isArray(models)||!models.length||models.length>30||models.some(id=>typeof id!=='string'||id.length>160||!id.trim()||/[\r\n\0]/.test(id)))throw new Error('无效的模型列表。');
  const config=readConfig();
  const catalog=prepareCatalog(config,models);
  if(!await compatibleWithInstalledCli(catalog))return {applied:false,catalog,note:'当前命令行 Codex 不能读取桌面版本的模型目录。已生成目录，但没有修改共享配置；原生模型菜单接入需要先统一版本。'};
  const backup=path.join(home(),'model-switcher',`config-before-catalog-${Date.now()}.toml`);
  fs.copyFileSync(path.join(home(),'config.toml'),backup,fs.constants.COPYFILE_EXCL);
  await withAppServer(c=>c.request('config/batchWrite',{edits:[{keyPath:'model_catalog_json',value:catalog,mergeStrategy:'upsert'}],reloadUserConfig:true}));
  return {applied:true,catalog,backup,note:'已保留原有模型并接入新模型目录。原生菜单可能需要重新启动桌面一次；日后新建这些模型的会话不需要再改配置。'};
}
async function action(name,args={},extra={}) {
  switch(name) {
    case 'open_schedule_panel':return {...await service.catalog(extra),initialMode:'schedule'};
    case 'list_model_schedules':return {jobs:schedules.list(),service:await scheduler.status()};
    case 'save_model_schedule':{const job=await schedules.save(args);let runtime;try{runtime=job.status==='ACTIVE'?await scheduler.ensure():await scheduler.status();}catch(error){runtime={running:false,error:error.message};}return {job,service:runtime};}
    case 'set_model_schedule_status':{if(!['ACTIVE','PAUSED'].includes(args.status))throw new Error('无效的任务状态。');const job=args.status==='PAUSED'?schedules.setStatus(args.id,args.status):await schedules.save({...schedules.readJob(args.id),threadRef:schedules.readJob(args.id).threadId,status:args.status});let runtime;try{runtime=job.status==='ACTIVE'?await scheduler.ensure():await scheduler.status();}catch(error){runtime={running:false,error:error.message};}return {job,service:runtime};}
    case 'acknowledge_model_schedule_run':return schedules.acknowledge(args.id,args.day);
    case 'stop_model_scheduler':{for(const job of schedules.jobs())schedules.setStatus(job.id,'PAUSED');return {service:await scheduler.stop(),paused:true};}
    case 'read_launcher_settings':return settings.get();
    case 'update_launcher_settings':return settings.update(args.set);
    case 'launch_from_settings':return settings.launch();
    case 'modify_from_settings':return settings.modify();
    case 'list_existing_threads':return service.existingThreads(args);
    case 'modify_existing_thread':return service.modifyExisting(args);
    case 'open_model_panel':case 'open_thread_model_panel':return service.catalog(extra);
    case 'list_provider_models':return service.models(args.providerId);
    case 'create_provider_thread':return service.create(args);
    case 'complete_provider_thread':return service.complete(args.operationId);
    case 'prepare_native_models':return nativeModels(args.models);
    case 'open_launcher_browser':return {url:browserLink};
    default:throw new Error('不支持的操作。');
  }
}
let html=fs.readFileSync(path.join(directory,'panel.html'),'utf8');
const token=randomBytes(32).toString('hex');
let origin,browserLink;
function authorized(request) {
  const header=request.headers.authorization||'';
  const expected=Buffer.from(`Bearer ${token}`),provided=Buffer.from(header);
  return provided.length===expected.length&&timingSafeEqual(provided,expected)&&(!request.headers.origin||request.headers.origin===origin);
}
const web=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
  if(req.method==='GET'&&req.url==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'");res.end(html);return;
  }
  if(req.method!=='POST'||req.url!=='/api'||!authorized(req)||!req.headers['content-type']?.startsWith('application/json')){res.writeHead(403).end();return;}
  let body='';
  try{
    for await(const chunk of req){body+=chunk;if(body.length>16384){res.writeHead(413).end();return;}}
    const data=JSON.parse(body);const result=await action(data.name,data.arguments);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({structuredContent:result}));
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({isError:true,content:[{type:'text',text:error.message}]}));}
});
await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${web.address().port}`;browserLink=origin+'/#token='+token;
if(process.argv.includes('--serve')) {
  const folder=path.join(home(),'model-switcher');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(folder,'launcher.json'),JSON.stringify({pid:process.pid,url:browserLink}),{mode:0o600});
  console.error('供应商与模型启动器已在本机运行。');
}else{
  const server=new Server({name:'codex-model-switcher',version:'0.4.0',icons},{capabilities:{tools:{},resources:{},experimental:{'openai/settings':{readTool:'read_launcher_settings',updateTool:'update_launcher_settings'}}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:URI,name:'供应商与模型',mimeType:'text/html;profile=mcp-app'}]}));
  server.setRequestHandler(ReadResourceRequestSchema,async request=>{
    if(request.params.uri!==URI)throw new Error('未知资源。');
    return {contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:html,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]};
  });
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try{const result=await action(request.params.name,request.params.arguments||{},extra);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){return {content:[{type:'text',text:error.message}],isError:true};}
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once('end',()=>{web.close();server.close().finally(()=>process.exit(0));});
}
}
main().catch(()=>{console.error('供应商与模型插件启动失败，请检查本机构建文件和 Node.js。');process.exitCode=1;});
