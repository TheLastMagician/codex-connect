import fs from 'node:fs';
import path from 'node:path';

export function clearLegacySessionData(state) {
  let changed=false;
  for(const session of Object.values(state.sessions||{})) {
    if(!session || typeof session!=='object')continue;
    for(const key of ['mode','routingVersion','assistantHistory'])if(Object.hasOwn(session,key)){delete session[key];changed=true;}
  }
  return changed;
}
export function removeLegacyAssistantData(directory,save) {
  const root=path.resolve(directory);let configRemoved=false,profilesUpdated=0;
  try {fs.unlinkSync(path.join(root,'assistant.json'));configRemoved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of fs.readdirSync(root)) {
    if(!/^(?:state|feishu-state-[0-9a-f-]{36}|feishu-fixed-(?:default|[0-9a-f-]{36})-[0-9a-f]{16}|wechat-state-[0-9a-f]{24})\.json$/i.test(name))continue;
    const file=path.join(root,name);if(!fs.lstatSync(file).isFile())continue;
    let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
    if(state && typeof state==='object' && clearLegacySessionData(state)){save(name,state);profilesUpdated++;}
  }
  return {configRemoved,profilesUpdated};
}
