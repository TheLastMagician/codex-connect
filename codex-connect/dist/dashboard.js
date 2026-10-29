const $=id=>document.getElementById(id);
const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
let csrf='',state,editing=null,catalogData=null,bound=null,busy=false,qrBusy=false,lastQr='',toastTimer;
const labels={connected:'已连接',connecting:'连接中',reconnecting:'重连中',failed:'连接失败',disabled:'已停用',not_configured:'待配置',waiting_login:'等待扫码',login_expired:'登录过期',login_required:'请重新扫码',paused:'已暂停'};
async function api(route,method='GET',value) {
  if(globalThis.codexConnectPanel)return globalThis.codexConnectPanel.request(route,method,value);
  const response=await fetch('/api/'+route,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json','X-Codex-Csrf':csrf}:{})},...(value!==undefined?{body:JSON.stringify(value)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'操作未完成');return result;
}
function toast(text,error=false){$('toast').textContent=text;$('toast').className='toast'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5000);}
function button(text,action,cls){const b=element('button',text,cls);b.type='button';b.addEventListener('click',()=>run(action));return b;}
async function run(action){try{await action();}catch(error){toast(error.message,true);}}
function badge(status){return element('span',labels[status]||status||'待连接','badge '+status);}
function confirmAction(title,detail){$('confirm-title').textContent=title;$('confirm-detail').textContent=detail;$('confirm-dialog').showModal();return new Promise(resolve=>{const done=value=>{$('confirm-dialog').close();resolve(value);};$('confirm-ok').onclick=()=>done(true);$('confirm-cancel').onclick=()=>done(false);$('confirm-dialog').oncancel=()=>resolve(false);});}
async function refresh(){const next=await api('state');state=next;render();}
function render(){
  $('content').classList.remove('hidden');$('locked').classList.add('hidden');$('paused').classList.toggle('hidden',!state.paused);
  $('desktop-status').textContent=state.desktopConnected?'● Codex 桌面已连接':'○ 正在等待 Codex 桌面';$('desktop-status').className='desktop-status'+(state.desktopConnected?'':' offline');
  $('version').textContent=state.version?'v'+state.version:'';$('bot-count').textContent=state.bots.filter(b=>b.configured).length;
  $('bots').replaceChildren(...state.bots.map(bot=>{
    const card=element('article',undefined,'bot'),top=element('div',undefined,'bot-top'),title=element('div',undefined,'grow');
    const channelState=state.channels[bot.id==='default'?'feishu':'feishu:'+bot.id]?.state||(bot.enabled?'not_configured':'disabled');
    top.append(element('div','飞','channel-icon'));title.append(element('h3',bot.name),element('div',bot.mode==='fixed'?'固定会话聊天':'完整管理','bot-mode'));top.append(title,badge(channelState));card.append(top);
    const target=element('div',undefined,'target');target.append(element('small',bot.mode==='fixed'?'绑定会话':'工作方式'),element('strong',bot.mode==='fixed'?bot.thread?.title||'尚未选择会话':bot.configured?'管理项目与所有会话':'连接你的第一个飞书机器人'));
    target.append(element('p',bot.mode==='fixed'?'所有输入都作为任务发送，沿用会话模型。':bot.configured?'项目、会话、模型设置与卡片交互。':'填写 App ID 和 App Secret 后启用。'));card.append(target);
    const platform=bot.mode==='fixed' && bot.accessMode==='feishu',pending=platform?[]:state.requests[bot.id]||[],users=bot.allowedOpenIds||[];
    if(platform)card.append(element('p','跟随飞书范围 · 无需逐个授权','access'));
    if(pending.length){const block=element('div',undefined,'access pending');block.append(element('strong',pending.length+' 个使用申请'));for(const request of pending){const row=element('div',undefined,'access-row');row.append(element('code',request.openId),button('允许',async()=>{await api('bots/'+bot.id+'/users','POST',{openId:request.openId,allowed:true});toast('已允许，请重新给机器人发消息');await refresh();}));block.append(row);}card.append(block);}
    const access=element('details',undefined,'access');access.append(element('summary','已授权 '+users.length+' 个账号'));for(const id of users){const row=element('div',undefined,'access-row');row.append(element('code',id),button('撤销',async()=>{if(await confirmAction('撤销这个账号？','撤销后，这个账号不能再向机器人发送任务。')){await api('bots/'+bot.id+'/users','POST',{openId:id,allowed:false});await refresh();}}));access.append(row);}if(!platform)card.append(access);
    const actions=element('div',undefined,'actions'),toggle=element('label',undefined,'switch'),input=element('input');input.type='checkbox';input.checked=bot.enabled&&bot.configured;input.disabled=!bot.configured;input.setAttribute('aria-label','启用 '+bot.name);toggle.append(input,element('span',bot.enabled&&bot.configured?'已启用':'未启用'));
    input.onchange=()=>run(async()=>{input.disabled=true;try{await api('bots','PUT',{id:bot.id,enabled:input.checked});await refresh();}catch(error){input.checked=!input.checked;throw error;}finally{input.disabled=false;}});
    actions.append(toggle,button(bot.configured?'编辑':'配置',()=>openBot(bot)));
    if(bot.id!=='default')actions.append(button('删除',async()=>{if(await confirmAction('删除“'+bot.name+'”？','会停止这个机器人的连接并移除配置，Codex 会话保留。')){await api('bots/'+bot.id,'DELETE',{});toast('机器人已删除');await refresh();}},'danger'));
    card.append(actions);return card;
  }));
  const wx=state.wechat,wxState=state.channels.wechat?.state||'not_configured';$('wechat-state').replaceWith(Object.assign(badge(wxState),{id:'wechat-state'}));
  $('wechat-detail').textContent=wx.configured?'登录已保存在本机；可暂停连接，或重新扫码换绑。':'首次连接请用手机微信扫码，在手机上确认。';
  const wxButtons=[];
  if(wx.configured)wxButtons.push(button(wx.enabled?'暂停':'启用',async()=>{await api('wechat/enabled','POST',{enabled:!wx.enabled});await refresh();}));
  wxButtons.push(button(wx.configured?'重新扫码':'扫码连接',async()=>{if(wx.configured && !await confirmAction('重新连接微信？','这会生成新的登录二维码；确认换绑后将使用新账号。'))return;await openQr(wx.configured);},wx.configured?'':'primary'));
  if(wx.configured)wxButtons.push(button('断开',async()=>{if(await confirmAction('断开微信？','将清除本机微信登录，需要重新扫码才能连接。')){await api('wechat/disconnect','POST',{});await refresh();}},'danger'));
  $('wechat-actions').replaceChildren(...wxButtons);$('autostart').checked=state.autostart.enabled;
  $('hook-note').textContent=state.autostart.enabled?'已注册启动钩子。首次请在 Codex 设置 → 钩子中审阅并信任。':'启用后注册本机启动钩子；首次需要在 Codex 设置中信任。';
  if($('qr-dialog').open)renderQr();
}
async function openBot(bot=null){editing=bot;bound=bot?.thread||null;$('bot-form').reset();$('form-error').textContent='';$('form-title').textContent=bot?'编辑机器人':'添加机器人';
  $('bot-name').value=bot?.name||'';$('app-id').value=bot?.appId||'';$('app-id').disabled=!!bot?.environmentCredentials;$('app-secret').disabled=!!bot?.environmentCredentials;
  $('app-secret').placeholder=bot?.secretConfigured?'已保存，留空保留':'输入应用凭据';$('app-secret').required=!bot?.secretConfigured;
  $('credential-note').textContent=bot?.environmentCredentials?'主机器人凭据由环境变量提供。其他配置仍可在此修改。':'飞书开放平台：启用机器人，长连接接收 im.message.receive_v1；群聊需额外开通接收群内 @ 消息的权限，并发布应用。';
  document.querySelector('input[name=mode][value="'+(bot?.mode||'fixed')+'"]').checked=true;$('bot-enabled').checked=bot?.enabled??true;document.querySelector('input[name=accessMode][value="'+(bot?.accessMode||(!bot?'feishu':'approved'))+'"]').checked=true;$('card-actions').checked=!!bot?.cardActionsEnabled;
  $('current-binding').textContent=bound?'当前绑定：'+bound.title:'选择后，机器人只能与这个会话聊天。';$('thread-search').value='';$('project-select').value='';
  $('thread-select').replaceChildren();$('bot-dialog').showModal();modeChanged();
  if(document.querySelector('input[name=mode]:checked').value==='fixed')await loadCatalog();
}
function modeChanged(){const fixed=document.querySelector('input[name=mode]:checked').value==='fixed';$('binding').classList.toggle('hidden',!fixed);$('thread-select').required=false;$('card-field').classList.toggle('hidden',fixed);$('access-field').classList.toggle('hidden',!fixed);accessChanged();}
function accessChanged(){const platform=document.querySelector('input[name=mode]:checked').value==='fixed' && document.querySelector('input[name=accessMode]:checked').value==='feishu';$('access-note').textContent=platform?'使用范围由飞书应用的可用范围和群管理设置控制。所有使用者共用绑定会话的上下文。':'首次私聊机器人或在群内 @ 它后，页面会显示使用申请。允许后重新发送消息，首次申请不会自动执行。';}
async function loadCatalog(){
  $('refresh-catalog').disabled=true;$('catalog-note').textContent='正在读取桌面项目与会话…';
  try{catalogData=await api('catalog');const filter=$('project-select').value;$('project-select').replaceChildren(new Option('全部项目',''),new Option('独立会话','__none'),...catalogData.projects.map(p=>new Option(p.label,p.projectId)));$('project-select').value=filter;filterThreads();$('catalog-note').textContent=catalogData.notice||`共 ${catalogData.threads.length} 个会话，可按项目或标题查找。`;}
  catch(error){catalogData=null;$('catalog-note').textContent=error.message+(bound?'；原有绑定仍可保留。':'');}
  finally{$('refresh-catalog').disabled=false;}
}
function filterThreads(){if(!catalogData)return;const project=$('project-select').value,query=$('thread-search').value.trim().toLowerCase();
  const list=catalogData.threads.filter(t=>(!project || (project==='__none'?!t.projectId:t.projectId===project)) && t.title.toLowerCase().includes(query));
  $('thread-select').replaceChildren(...list.map(t=>new Option(t.title+' · '+t.projectLabel,JSON.stringify({id:t.id,hostId:t.hostId}))));
  $('thread-select').value=bound?JSON.stringify({id:bound.id,hostId:bound.hostId}):'';
}
async function saveBot(event){event.preventDefault();if(busy)return;busy=true;$('save-bot').disabled=true;$('form-error').textContent='';
  try{const mode=document.querySelector('input[name=mode]:checked').value;
    const input={...(editing?{id:editing.id}:{}),name:$('bot-name').value,appId:$('app-id').value,appSecret:$('app-secret').value,mode,enabled:$('bot-enabled').checked,cardActionsEnabled:$('card-actions').checked,accessMode:mode==='fixed'?document.querySelector('input[name=accessMode]:checked').value:'approved'};
    if(mode==='fixed'){if(!bound)throw new Error('请选择要绑定的会话');input.thread={id:bound.id,hostId:bound.hostId};}
    await api('bots','POST',input);$('bot-dialog').close();toast('配置已保存，正在应用连接');await refresh();
  }catch(error){$('form-error').textContent=error.message;}finally{busy=false;$('save-bot').disabled=false;}
}
async function openQr(refresh=false){$('qr-dialog').showModal();$('qr-status').textContent='正在生成二维码…';$('qr-image').replaceChildren();await newQr(refresh);}
async function newQr(refresh){if(qrBusy)return;qrBusy=true;$('refresh-qr').disabled=true;try{await api('wechat/login','POST',{refresh});lastQr='';await refreshStateQr();}catch(error){$('qr-status').textContent=error.message;}finally{qrBusy=false;$('refresh-qr').disabled=false;}}
async function refreshStateQr(){await refresh();renderQr();}
function renderQr(){const wx=state.wechat,labels={wait:'等待扫码',scaned:'已扫码，请在手机确认',need_verifycode:'请填写手机显示的配对验证码',confirmed:'连接成功',expired:'二维码已过期，请刷新',cancelled:'已取消登录',bound_elsewhere:'这个账号已在其他地方绑定',failed:'登录失败，请重新扫码'};
  $('qr-status').textContent=labels[wx.status]||'请生成登录二维码';$('verify-form').classList.toggle('hidden',!wx.needsCode);
  if(wx.hasQr){if(lastQr!==wx.loginId){lastQr=wx.loginId;const img=element('img');img.alt='微信登录二维码';
    if(globalThis.codexConnectPanel){const id=wx.loginId;run(async()=>{try{const qr=await api('wechat/qr');if(lastQr===id && state.wechat.hasQr){img.src=qr.dataUrl;$('qr-image').replaceChildren(img);}}catch(error){if(lastQr===id)lastQr='';throw error;}});}
    else{img.src='/api/wechat/qr?login='+encodeURIComponent(wx.loginId);$('qr-image').replaceChildren(img);}}}
  else{$('qr-image').replaceChildren();lastQr='';}
}
$('add-bot').onclick=()=>run(()=>openBot());$('bot-form').onsubmit=saveBot;$('refresh-catalog').onclick=()=>run(loadCatalog);
document.querySelectorAll('input[name=mode]').forEach(input=>input.onchange=()=>{modeChanged();if(input.value==='fixed' && !catalogData)run(loadCatalog);});
document.querySelectorAll('input[name=accessMode]').forEach(input=>input.onchange=accessChanged);
$('project-select').onchange=filterThreads;$('thread-search').oninput=filterThreads;$('thread-select').onchange=()=>{if($('thread-select').value){bound=JSON.parse($('thread-select').value);$('current-binding').textContent='已选择：'+catalogData.threads.find(t=>t.id===bound.id && t.hostId===bound.hostId)?.title;}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('refresh-qr').onclick=()=>run(()=>newQr(true));$('verify-form').onsubmit=event=>{event.preventDefault();run(async()=>{await api('wechat/verify','POST',{code:$('verify-code').value});$('verify-code').value='';toast('验证码已提交');await refresh();});};
$('autostart').onchange=()=>run(async()=>{try{await api('autostart','POST',{enabled:$('autostart').checked});await refresh();toast('自动连接设置已保存');}catch(error){$('autostart').checked=!$('autostart').checked;throw error;}});
$('resume').onclick=()=>run(async()=>{await api('resume','POST',{});await refresh();});
document.querySelectorAll('nav a').forEach(link=>link.addEventListener('click',()=>{document.querySelectorAll('nav a').forEach(item=>item.classList.toggle('active',item===link));}));
async function boot(){try{if(globalThis.codexConnectPanel)await globalThis.codexConnectPanel.ready;else{const token=location.hash.slice(1);if(token && /^[0-9a-f]{64}$/.test(token)){csrf=(await api('session','POST',{token})).csrf;history.replaceState(null,'',location.pathname);}else csrf=(await api('session')).csrf;}await refresh();setInterval(()=>{if(!document.hidden)refresh().catch(error=>toast(error.message,true));},4000);}catch(error){$('locked').classList.remove('hidden');$('desktop-status').textContent='连接暂不可用';toast(error.message,true);}}
boot();
