import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-only-smoke-'));
const client=new Client({name:'wechat-only-smoke',version:'0.2.0'});let pid;
fs.writeFileSync(path.join(folder,'wechat-login.json'),JSON.stringify({status:'wait',expiresAt:Date.now()+60000}));
const transport=new StdioClientTransport({command:process.execPath,args:['dist/server.cjs'],env:{...process.env,FEISHU_CODEX_DATA_DIR:folder,FEISHU_APP_ID:'',FEISHU_APP_SECRET:''}});
try {
  await client.connect(transport);
  const tools=await client.listTools();
  if(!tools.tools.some(t=>t.name==='wechat_login'))throw new Error('Missing WeChat login tool');
  const started=await client.callTool({name:'start_bridge',arguments:{}});if(started.isError)throw new Error(started.content[0].text);
  pid=JSON.parse(started.content[0].text).pid;await delay(2500);
  const result=await client.callTool({name:'bridge_status',arguments:{}});const status=JSON.parse(result.content[0].text);
  if(status.state!=='running' || status.feishuConfigured || status.feishuState!=='not_configured')throw new Error('WeChat-only startup failed');
  console.log(JSON.stringify({version:status.version,state:status.state,feishuConfigured:status.feishuConfigured,wechatState:status.wechatState,tools:tools.tools.map(t=>t.name)}));
}finally {
  if(pid) {
    await client.callTool({name:'stop_bridge',arguments:{}});
    let alive=true;
    for(let i=0;i<10 && alive;i++){await delay(100);try{process.kill(pid,0);}catch{alive=false;}}
    if(alive)throw new Error('Smoke bridge still running; preserved temporary files');
  }
  await client.close();
  if(!path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-wechat-only-smoke-'))throw new Error('Unexpected cleanup path');
  fs.rmSync(folder,{recursive:true,force:true});
}
