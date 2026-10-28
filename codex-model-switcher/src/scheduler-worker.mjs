import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ScheduleStore,tickSchedules,scheduleDirectory,SCHEDULER_VERSION,atomicJson} from './schedules.mjs';
import {schedulerPipe} from './scheduler-runtime.mjs';
import {dispatchScheduled,observeScheduled} from './scheduled-turn.mjs';
import {ProviderChangeStore,processProviderChanges} from './provider-changes.mjs';

async function main(){
  const store=new ScheduleStore(),changes=new ProviderChangeStore(),tokenFile=path.join(scheduleDirectory(),'control.key');
  const token=fs.readFileSync(tokenFile,'utf8');let stopping=false,working=false;
  const server=net.createServer(socket=>{
    socket.setTimeout(2000,()=>socket.destroy());let data='';
    socket.on('error',()=>{});socket.on('data',chunk=>{
      data+=chunk;if(data.length>4096)return socket.destroy();if(!data.includes('\n'))return;
      let request;try{request=JSON.parse(data);}catch{return socket.destroy();}
      if(request.command==='stop'){
        const received=Buffer.from(request.token||''),expected=Buffer.from(token);
        if(received.length!==expected.length||!timingSafeEqual(received,expected))return socket.destroy();
        stopping=true;
      }
      socket.end(JSON.stringify({running:true,version:SCHEDULER_VERSION,pid:process.pid,working,stopping})+'\n');
    });
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(schedulerPipe(),resolve);});}
  catch(error){if(error.code==='EADDRINUSE')return;throw error;}
  server.on('error',()=>{stopping=true;});
  process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  while(!stopping){
    working=true;
    try{
      await tickSchedules(store,{dispatch:dispatchScheduled,observe:observeScheduled});
      await processProviderChanges(changes);
      atomicJson(path.join(scheduleDirectory(),'health.json'),{pid:process.pid,version:SCHEDULER_VERSION,heartbeatAt:Date.now()});
    }catch{atomicJson(path.join(scheduleDirectory(),'health.json'),{pid:process.pid,version:SCHEDULER_VERSION,heartbeatAt:Date.now(),error:'定时服务检查失败，请检查插件运行记录。'});}
    working=false;
    const steps=changes.list().some(j=>['waiting','applying'].includes(j.status))?2:15;
    for(let i=0;i<steps&&!stopping;i++)await delay(1000);
  }
  await new Promise(resolve=>server.close(resolve));
}
main().catch(()=>{process.exitCode=1;});
