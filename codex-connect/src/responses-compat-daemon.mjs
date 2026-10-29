import {readJson,writeJson} from './storage.mjs';
import {VERSION} from './version.mjs';
import {createResponsesCompatServer} from './responses-compat.mjs';
import {configureResponsesCompat} from './responses-compat-settings.mjs';

async function main() {
  const settings=readJson('responses-compat.json',{});
  if(process.argv[2]==='restore') {
    for(const route of settings.routes||[])await configureResponsesCompat({providerId:route.providerId,enabled:false});
    console.log('已恢复原供应商地址并关闭兼容服务自动启动。请重启 Codex。');return;
  }
  if(!settings.routes?.length || !settings.instanceId)return;
  let converted=0;let server;let timer;
  const save=state=>writeJson('responses-compat-status.json',{state,pid:process.pid,version:VERSION,
    instanceId:settings.instanceId,port:server?.address()?.port||settings.port,converted,checkedAt:Date.now()});
  server=createResponsesCompatServer({instanceId:settings.instanceId,
    getRoutes:()=>readJson('responses-compat.json',{}).routes||[],
    onConverted:count=>{converted+=count;save('running');}});
  server.on('clientError',(_,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.port||0,'127.0.0.1',resolve);});
  save('running');
  const stop=()=>{clearInterval(timer);server.close();server.closeAllConnections();save('stopped');};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  timer=setInterval(()=>{
    try{const current=readJson('responses-compat.json',{});if(current.instanceId!==settings.instanceId || !current.routes?.length)stop();}
    catch{} // A transient unreadable settings file must not interrupt desktop model traffic.
  },2000);
}
main().catch(()=>{console.error('本机 Responses 兼容服务未能启动，请检查插件兼容状态。');process.exitCode=1;});
