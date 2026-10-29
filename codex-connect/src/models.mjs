export const EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra'];
export const threadKey=thread=>`${thread.hostId||'local'}:${thread.id}`;

export function parseModelCatalog(tools) {
  const description=tools.find(t=>t.name==='send_message_to_thread')?.inputSchema?.properties?.model?.description||'';
  const models=[];
  const pattern=/([a-zA-Z0-9][\w.:-]*)\s*\(([^)]*?);\s*supported reasoning efforts:\s*([\w, ]+)\)/g;
  for(const match of description.matchAll(pattern)) {
    const efforts=match[3].split(',').map(s=>s.trim()).filter(s=>EFFORTS.includes(s));
    if(efforts.length)models.push({id:match[1],description:match[2].trim(),efforts});
  }
  if(!models.length)throw new Error('当前桌面接口未提供可解析的模型目录，请在桌面选择模型。');
  return [...new Map(models.map(m=>[m.id,m])).values()];
}
export function modelSettings(session,thread=session.selected) {
  return thread?session.modelOverrides?.[threadKey(thread)]||{}:{};
}
export function modelSummary(session) {
  const settings=modelSettings(session);
  return `模型｜${settings.model||'沿用桌面会话设置'}\n推理强度｜${settings.thinking||'沿用桌面会话设置'}`;
}
export function taskModelArgs(session) {
  const settings=modelSettings(session);
  return {...(settings.model?{model:settings.model}:{}),...(settings.thinking?{thinking:settings.thinking}:{})};
}
export async function loadModels(desktop,session) {
  session.models=parseModelCatalog(await desktop.tools());
  return session.models;
}
