import path from 'node:path';
import {desktopContext,ensureBridge} from './bridge-lifecycle.mjs';
import {readJson,writeJson} from './storage.mjs';

async function main() {
  if(readJson('autostart.json',{}).enabled!==true)return;
  let raw='';
  for await(const chunk of process.stdin) {
    raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>65536)return;
  }
  let event;try{event=JSON.parse(raw);}catch{return;}
  if(event.hook_event_name!=='SessionStart' || !['startup','resume','clear','fork'].includes(event.source))return;
  try {
    // A global hook can also run in a separate CLI. Never bind that CLI's
    // session ID to a saved desktop pipe when no desktop host supplied one.
    if(!process.env.CODEX_APP_TOOLS_PIPE_PATH)throw new Error('No desktop host context');
    const context=desktopContext(undefined,{event});
    const result=await ensureBridge(context,{automatic:true,entryPath:path.join(__dirname,'bridge.cjs')});
    writeJson('autostart-status.json',{state:result.skipped||'started',checkedAt:Date.now()});
  }catch {
    writeJson('autostart-status.json',{state:'waiting_desktop',checkedAt:Date.now()});
  }
  // Hooks return no model context, send no messages, and never block a session.
}
main().catch(()=>{});
