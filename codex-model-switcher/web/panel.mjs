import {App,applyDocumentTheme,applyHostStyleVariables} from '@modelcontextprotocol/ext-apps';
const $=id=>document.getElementById(id);
let catalog,models=[],currentResult,loading=false,modelGeneration=0,call;
let currentOperation=null;
let editing=false,scheduling=false,existing=[],threadCursor=null,threadGeneration=0,scheduleId=crypto.randomUUID();
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function unpack(result){if(result.isError)throw new Error(result.content?.map(i=>i.text||'').join('\n')||'操作失败');return result.structuredContent||JSON.parse(result.content?.find(i=>i.type==='text')?.text||'{}');}
function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label;return node;}
const modelId=()=>$('manual').checked?$('manual-model').value.trim():$('model').value;
function update(){
  const provider=catalog?.providers.find(p=>p.id===$('provider').value),model=modelId();
  $('selection').textContent=provider&&model?`${provider.name} (${provider.id}) → ${model}`:'请选择供应商和模型';
  $('create').disabled=loading||!provider||!model||!$('project').value||!$('cwd').value||!$('title').value.trim();
  $('native').disabled=loading||!model||$('provider').value==='openai';
  $('edit-submit').disabled=loading||!catalog||!$('edit-provider').value||!$('edit-ref').value.trim()||!$('edit-model').value.trim();
  for(const id of ['mode-create','mode-edit','mode-schedule'])$(id).disabled=loading||!catalog;
  for(const id of ['schedule-stop','schedule-new'])$(id).disabled=loading;
  $('refresh').disabled=loading;
}
async function loadExisting(reset=true){
  const providerId=$('edit-provider').value;if(!providerId)return;
  const generation=++threadGeneration;if(reset){existing=[];threadCursor=null;}
  $('edit-thread').disabled=true;$('more-threads').disabled=true;$('thread-source').textContent='正在读取已有会话…';
  try{
    const result=await call('list_existing_threads',{providerId,...(threadCursor?{cursor:threadCursor}:{})});
    if(generation!==threadGeneration)return;
    existing=[...new Map([...existing,...result.threads].map(t=>[t.id,t])).values()];threadCursor=result.nextCursor;
    $('edit-thread').replaceChildren(option('','请选择会话'),...existing.map(t=>option(t.id,`${t.title} · ${t.id.slice(-8)}`)));
    const id=$('edit-ref').value.trim().replace(/^codex:\/\/threads\//i,'');
    if(existing.some(t=>t.id===id))$('edit-thread').value=id;
    $('edit-thread').disabled=!existing.length;$('more-threads').hidden=!threadCursor;
    $('thread-source').textContent=`${existing.length} 个 ${providerId} 会话，按最近更新排序。未列出的会话可直接粘贴链接。`;
  }catch(error){if(generation===threadGeneration)$('thread-source').textContent=error.message+' 仍可粘贴会话链接。';}
  finally{if(generation===threadGeneration)$('more-threads').disabled=false;}
}
function switchMode(value){
  editing=value===true;scheduling=value==='schedule';$('create-section').hidden=editing||scheduling;$('edit-section').hidden=!editing;$('schedule-section').hidden=!scheduling;$('advanced').hidden=editing||scheduling;
  $('result').hidden=editing||scheduling||!currentResult;
  $('mode-create').setAttribute('aria-pressed',String(!editing&&!scheduling));$('mode-edit').setAttribute('aria-pressed',String(editing));$('mode-schedule').setAttribute('aria-pressed',String(scheduling));
  status('');if(editing)loadExisting();if(scheduling)loadSchedules();
}
const dateLabel=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(value):'已暂停';
function scheduleForm(job){
  scheduleId=job?.id||crypto.randomUUID();
  $('schedule-name').value=job?.name||'';$('schedule-ref').value=job?.threadId?`codex://threads/${job.threadId}`:'';
  $('schedule-prompt').value=job?.prompt||'';$('schedule-time').value=job?.time||'23:00';$('schedule-status').value=job?.status||'ACTIVE';
}
async function loadSchedules(){
  try{
    const result=await call('list_model_schedules',{});
    $('schedule-service').textContent=result.service.running?'后台服务已连接':'后台服务未连接；启用任务时会尝试启动';
    $('schedule-jobs').replaceChildren();
    const labels={waiting:'等待发送',submitting:'正在提交（结果待确认）',accepted:'已接收，等待完成',unknown:'结果未知，已阻塞后续发送',missed:'已跳过',reviewed:'用户已核对',completed_verified:'已完成，模型已核对',completed_unverified:'已完成，模型未核对',failed:'执行失败',interrupted:'已中断',model_mismatch:'模型不一致'};
    for(const job of result.jobs){
      const card=document.createElement('article');card.className='result';
      const title=document.createElement('h2');title.textContent=job.name;
      const info=document.createElement('p');info.className='hint';info.textContent=`每天 ${job.time} 北京时间 · ${job.status==='ACTIVE'?'启用':'暂停'} · 下次：${dateLabel(job.nextRunAt)}\n${job.providerId} / ${job.model} / ${job.effort}\n${job.title} · ${job.threadId}`;
      const edit=document.createElement('button');edit.type='button';edit.textContent='编辑';edit.onclick=()=>scheduleForm(job);
      const toggle=document.createElement('button');toggle.type='button';toggle.textContent=job.status==='ACTIVE'?'暂停任务':'启用任务';toggle.onclick=()=>busy(async()=>{const r=await call('set_model_schedule_status',{id:job.id,status:job.status==='ACTIVE'?'PAUSED':'ACTIVE'});await loadSchedules();status(r.service?.error||'任务状态已保存。',!!r.service?.error);});
      card.append(title,info,edit,toggle);
      for(const run of job.runs||[]){
        const line=document.createElement('p');line.className='hint';line.textContent=`${run.day}：${labels[run.status]||run.status}。${run.note||''}`;card.append(line);
        if(['unknown','submitting'].includes(run.status)&&Date.now()-run.updatedAt>=120000){const ack=document.createElement('button');ack.type='button';ack.textContent='已核对原会话，解除阻塞';ack.onclick=()=>busy(async()=>{await call('acknowledge_model_schedule_run',{id:job.id,day:run.day});await loadSchedules();status('阻塞已解除，本次不会重发。');});card.append(ack);}
      }
      $('schedule-jobs').append(card);
    }
    if(!result.jobs.length)$('schedule-jobs').textContent='还没有插件定时任务。';
    const threads=await call('list_existing_threads',{providerId:'custom'});
    $('schedule-thread').replaceChildren(option('','请选择会话，或直接粘贴链接'),...threads.threads.map(t=>option(t.id,`${t.title} · ${t.id.slice(-8)}`)));
  }catch(error){status(error.message,true);}
}
function updateEffort(){
  const selected=models.find(m=>m.id===modelId());
  const efforts=$('provider').value==='openai'&&selected?.efforts?.length?selected.efforts:['none','minimal','low','medium','high','xhigh','max','ultra'];
  $('effort').replaceChildren(...efforts.map(e=>option(e,e==='none'?'不额外指定预算':e)));
  const preferred=catalog.launcherDefaults?.providerId===$('provider').value?catalog.launcherDefaults:null;
  const remembered=preferred?.effort||localStorage.getItem('model-switcher:effort:'+$('provider').value),fallback=selected?.defaultEffort||($('provider').value==='openai'?'medium':'xhigh');
  $('effort').value=efforts.includes(remembered)?remembered:efforts.includes(fallback)?fallback:efforts[0];
  $('effort-note').textContent=$('provider').value==='openai'?'使用账号模型提供的强度选项。':'按所选值请求供应商，实际推理预算由供应商决定。';
}
function updateProject(cwd){
  const project=catalog.projects.find(p=>p.id===$('project').value);
  $('cwd').replaceChildren(...(project?.roots||[]).map(root=>option(root,root)));
  if(project?.roots.includes(cwd))$('cwd').value=cwd;
  $('cwd').disabled=!project||project.roots.length<2;
  $('project-source').textContent=project?'来自 Codex 已有项目':'请先在 Codex 添加本机项目，再刷新';
  update();
}
async function loadModels(){
  const id=$('provider').value,generation=++modelGeneration;
  $('endpoint').textContent=catalog.providers.find(p=>p.id===id)?.baseUrl||'';
  $('model').disabled=true;$('model').replaceChildren(option('','正在读取模型目录…'));$('model-source').textContent='';update();
  try{
    const result=await call('list_provider_models',{providerId:id});if(generation!==modelGeneration)return;
    models=result.models||[];$('model').replaceChildren(...models.map(m=>option(m.id,m.name===m.id?m.id:`${m.name} · ${m.id}`)));
    const last=catalog.launcherDefaults?.providerId===id?catalog.launcherDefaults.model:localStorage.getItem('model-switcher:model:'+id);
    $('model').value=models.some(m=>m.id===last)?last:models.find(m=>m.id===catalog.defaultModel)?.id||models.find(m=>m.id==='qwen3.8-27b')?.id||models.find(m=>/^qwen/i.test(m.id))?.id||models[0]?.id||'';
    $('model-source').textContent=result.source+' · '+models.length+' 个模型';$('model').disabled=!models.length;
  }catch(error){if(generation!==modelGeneration)return;models=[];$('model').replaceChildren(option('','目录读取失败，请手动输入'));$('model-source').textContent=error.message;$('manual').checked=true;$('manual-model').hidden=false;}
  if(generation!==modelGeneration)return;updateEffort();update();
}
async function refresh(){
  status('正在读取本机配置…');
  try{
    catalog=await call('open_model_panel',{});
    const priorProvider=$('edit-provider').value;
    $('edit-provider').replaceChildren(...catalog.providers.map(p=>option(p.id,`${p.name} · ${p.id}`)));$('edit-provider').disabled=false;
    $('edit-provider').value=catalog.providers.some(p=>p.id===(priorProvider||'custom'))?(priorProvider||'custom'):catalog.launcherDefaults.providerId;
    if(!$('edit-ref').value&&catalog.currentThread?.providerId===$('edit-provider').value)$('edit-ref').value=`codex://threads/${catalog.currentThread.id}`;
    $('provider').replaceChildren(...catalog.providers.map(p=>option(p.id,`${p.name} · ${p.id}`)));$('provider').disabled=false;
    const preferred=catalog.launcherDefaults?.providerId||catalog.defaultProvider;
    $('provider').value=catalog.providers.some(p=>p.id===preferred)?preferred:catalog.providers[0]?.id||'';
    const projectId=$('project').value||localStorage.getItem('model-switcher:project')||catalog.defaultProjectId;
    $('project').replaceChildren(...catalog.projects.map(p=>option(p.id,p.name)));
    $('project').disabled=!catalog.projects.length;
    $('project').value=catalog.projects.some(p=>p.id===projectId)?projectId:catalog.defaultProjectId||catalog.projects[0]?.id||'';
    updateProject(catalog.defaultCwd);
    if(!$('title').value)$('title').value='新会话';
    await loadModels();if(editing&&!loading)await loadExisting();if(scheduling&&!loading)await loadSchedules();if(!editing&&!scheduling&&!loading)status(catalog.note);
  }catch(error){status(error.message,true);}
}
function displayResult(result){
  currentResult=result;$('result').hidden=false;$('result-title').textContent=result.title;
  const items=[['供应商',result.providerId],['模型',result.model],['强度',result.observed?.reasoningEffort||result.effort],['项目',result.projectName||'未记录'],['目录',result.cwd],['状态',result.status==='settings_verified'?'底层设置已读回核对':'待桌面确认'],['会话 ID',result.threadId]];
  $('result-data').replaceChildren(...items.flatMap(([key,value])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;return[dt,dd];}));
  $('result-note').textContent=result.note||'已保存所选设置。发送前请核对会话输入框显示的模型。';
  localStorage.setItem('model-switcher:last-result',JSON.stringify(result));
}
async function busy(action){if(loading)return;loading=true;for(const id of ['create-form','edit-form','schedule-form','schedule-jobs'])$(id).inert=true;update();$('complete').disabled=true;try{await action();}catch(error){status(error.message,true);}finally{loading=false;for(const id of ['create-form','edit-form','schedule-form','schedule-jobs'])$(id).inert=false;$('complete').disabled=false;update();}}
$('edit-effort').replaceChildren(...['none','minimal','low','medium','high','xhigh','max','ultra'].map(e=>option(e,e)));$('edit-effort').value='xhigh';
$('mode-create').onclick=()=>switchMode(false);$('mode-edit').onclick=()=>switchMode(true);
$('mode-schedule').onclick=()=>switchMode('schedule');$('schedule-new').onclick=()=>scheduleForm();
$('schedule-stop').onclick=()=>busy(async()=>{const result=await call('stop_model_scheduler',{});await loadSchedules();status(result.service.running?'所有任务已暂停；后台服务正在退出。':'所有任务已暂停，后台服务和登录自启动已停用。');});
$('schedule-thread').onchange=()=>{if($('schedule-thread').value)$('schedule-ref').value=`codex://threads/${$('schedule-thread').value}`;};
$('schedule-form').onsubmit=event=>{event.preventDefault();busy(async()=>{
  const result=await call('save_model_schedule',{id:scheduleId,name:$('schedule-name').value.trim(),threadRef:$('schedule-ref').value.trim(),prompt:$('schedule-prompt').value.trim(),time:$('schedule-time').value,status:$('schedule-status').value});
  await loadSchedules();status(result.service.error||`任务已保存，下次执行：${dateLabel(result.job.nextRunAt)}。`,!!result.service.error);
});};
$('edit-provider').onchange=()=>{$('edit-ref').value='';$('edit-result').hidden=true;loadExisting();update();};
$('edit-thread').onchange=()=>{$('edit-ref').value=$('edit-thread').value?`codex://threads/${$('edit-thread').value}`:'';$('edit-result').hidden=true;update();};
for(const id of ['edit-ref','edit-model','edit-effort'])$(id).addEventListener('input',()=>{$('edit-result').hidden=true;update();});
$('reload-threads').onclick=()=>loadExisting();$('more-threads').onclick=()=>loadExisting(false);
$('edit-form').onsubmit=event=>{event.preventDefault();busy(async()=>{
  $('edit-result').hidden=true;status('正在打开所选会话、修改模型并等待设置读回…');
  const result=await call('modify_existing_thread',{threadRef:$('edit-ref').value.trim(),providerId:$('edit-provider').value,model:$('edit-model').value.trim(),effort:$('edit-effort').value});
  const verified=result.status==='settings_verified';
  $('edit-result').hidden=false;$('edit-result-text').textContent=`${result.title} · ${result.providerId} / ${result.model} / ${result.effort}。${result.note||'仅完成设置核对，尚未验证实际消息请求。'}`;
  $('edit-result-link').href=result.url;
  status(verified?(result.requiresContextReview?'模型设置已修改；历史上下文仍属于旧模型，请先处理压缩。':'模型设置已读回确认；实际消息请求尚未验证。'):result.note,!verified||result.requiresContextReview);
});};
$('provider').onchange=()=>{currentOperation=null;localStorage.setItem('model-switcher:provider',$('provider').value);$('manual').checked=false;$('manual-model').hidden=true;loadModels();};
$('model').onchange=()=>{currentOperation=null;localStorage.setItem('model-switcher:model:'+$('provider').value,modelId());updateEffort();update();};
$('project').onchange=()=>{currentOperation=null;localStorage.setItem('model-switcher:project',$('project').value);updateProject();};
$('effort').onchange=()=>localStorage.setItem('model-switcher:effort:'+$('provider').value,$('effort').value);
$('manual').onchange=()=>{$('manual-model').hidden=!$('manual').checked;currentOperation=null;updateEffort();update();};
for(const id of ['manual-model','cwd','title','effort'])$(id).addEventListener('input',()=>{currentOperation=null;update();});
$('refresh').onclick=refresh;$('reload-models').onclick=loadModels;
$('create-form').onsubmit=event=>{event.preventDefault();busy(async()=>{
  currentOperation??=crypto.randomUUID();status('正在创建真实会话并等待桌面确认，请勿重复点击…');
  const result=await call('create_provider_thread',{operationId:currentOperation,providerId:$('provider').value,model:modelId(),projectId:$('project').value,cwd:$('cwd').value,title:$('title').value.trim(),effort:$('effort').value});
  displayResult(result);status(result.status==='settings_verified'?'会话已创建，供应商、模型和思考强度已读回核对。':'会话已创建，桌面设置还需要确认。');
});};
$('complete').onclick=()=>busy(async()=>{status('正在打开已创建的会话并核对设置…');displayResult(await call('complete_provider_thread',{operationId:currentResult.operationId}));status('已刷新该会话的设置。');});
$('native').onclick=()=>busy(async()=>{status('正在验证模型目录与命令行版本的兼容性…');const result=await call('prepare_native_models',{models:[modelId()]});$('native-note').textContent=result.note;status(result.applied?'模型目录已保存，账号和默认供应商未变。':result.note,!result.applied);});
try{const saved=JSON.parse(localStorage.getItem('model-switcher:last-result')||'null');if(saved?.threadId)displayResult(saved);}catch{}
if(window.parent===window){
  const params=new URLSearchParams(location.hash.slice(1));const token=params.get('token')||sessionStorage.getItem('model-switcher:token');
  if(token)sessionStorage.setItem('model-switcher:token',token);history.replaceState(null,'',location.pathname);
  call=async(name,args)=>{const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({name,arguments:args})});return unpack(await response.json());};
  refresh();
}else{
  const app=new App({name:'供应商与模型',version:'0.3.0'});
  function apply(ctx){if(ctx.theme)applyDocumentTheme(ctx.theme);if(ctx.styles?.variables)applyHostStyleVariables(ctx.styles.variables);if(ctx.safeAreaInsets){const s=ctx.safeAreaInsets;document.body.style.padding=`${s.top}px ${s.right}px ${s.bottom}px ${s.left}px`;}}
  app.onhostcontextchanged=apply;app.ontoolresult=result=>{if(result.structuredContent?.initialMode==='schedule')switchMode('schedule');};app.onerror=()=>status('面板与 Codex 的连接暂不可用，请重新打开。',true);
  call=async(name,args)=>unpack(await app.callServerTool({name,arguments:args}));
  app.connect().then(()=>{const ctx=app.getHostContext();if(ctx)apply(ctx);return refresh();}).catch(error=>status(error.message,true));
}
