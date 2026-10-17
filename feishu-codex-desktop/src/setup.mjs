import readline from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {secureDirectory,readJson,writeJson,dataDir} from './storage.mjs';
import {beginWechatLogin} from './wechat-auth.mjs';
import {configureAutostart} from './autostart-settings.mjs';
import {providerCatalogStatus,responsesCompatStatus,configureResponsesCompat} from './responses-compat-settings.mjs';
import {ensureBridge,desktopContext} from './bridge-lifecycle.mjs';
import {syncAutostartRuntime} from './autostart-settings.mjs';
import {dashboardLink} from './dashboard.mjs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

async function hiddenQuestion(prompt) {
  let muted=false;
  const output=new Writable({write(chunk,encoding,next){if(!muted) process.stdout.write(chunk);next();}});
  const input=readline.createInterface({input:process.stdin,output,terminal:process.stdin.isTTY});
  const answer=input.question(prompt);muted=true;
  try{return (await answer).trim();}finally{input.close();process.stdout.write('\n');}
}
async function main() {
  if(process.argv[2]==='dashboard') {
    syncAutostartRuntime(__dirname);let context;try{context=desktopContext();}catch{context={};}
    const started=await ensureBridge(context,{entryPath:path.join(__dirname,'bridge.cjs'),management:true});
    for(let i=0;i<100;i++){if(readJson('dashboard.json',{}).pid===started.pid){console.log(dashboardLink());return;}await delay(100);}
    throw new Error('管理页面正在启动，请稍后重试');
  }
  if(process.argv[2]==='compat') {
    const mode=process.argv[3]||'status';
    if(mode==='status')console.log(JSON.stringify({...responsesCompatStatus(),catalog:await providerCatalogStatus()},null,2));
    else if(mode==='off' && process.argv[4])console.log(JSON.stringify(await configureResponsesCompat(
      {providerId:process.argv[4],enabled:false}),null,2));
    else throw new Error('全局兼容已停用。使用 node dist/setup.cjs compat status，或 compat off 供应商ID 恢复原地址');
    return;
  }
  if(process.argv[2]==='autostart') {
    if(!['on','off'].includes(process.argv[3]))throw new Error('使用 node dist/setup.cjs autostart on 或 off');
    console.log(JSON.stringify(configureAutostart(process.argv[3]==='on',{bundleDir:__dirname}),null,2));return;
  }
  if(process.argv[2]==='wechat') {
    const login=await beginWechatLogin({refresh:process.argv.includes('--refresh')});
    console.log(JSON.stringify(login,null,2));
    console.log('用微信扫一扫二维码图片并确认，然后回到 Codex 启动桌面聊天桥接。');return;
  }
  if(process.argv[2] && process.argv[2]!=='feishu')throw new Error('使用 setup.cjs 配置飞书，或使用 dashboard、wechat、autostart on/off。');
  secureDirectory();
  const previous=readJson('config.json',{});
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  console.log('飞书 Codex 桌面桥接 · 本地配置\n创建飞书自建应用并启用机器人后填写凭据。');
  let appId;
  try{appId=(await rl.question(`App ID${previous.appId?'（回车保留）':''}: `)).trim()||previous.appId;}finally{rl.close();}
  const appSecret=await hiddenQuestion(`App Secret${previous.appSecret?'（回车保留）':''}: `)||previous.appSecret;
  if(!appId || !appSecret) throw new Error('App ID 和 App Secret 都不能为空');
  const code=randomBytes(12).toString('hex');
  writeJson('config.json',{...previous,appId,appSecret,allowedOpenIds:previous.allowedOpenIds||[],pairing:{code,expiresAt:Date.now()+10*60*1000}});
  console.log(`配置已保存到 ${dataDir}（仅当前 Windows 用户可访问）。\n回到 Codex 桌面，调用插件 start_bridge。\n然后在飞书私聊机器人，发送：/pair ${code}\n配对码 10 分钟后过期；配对用户可以控制桌面会话。\n不要把 App Secret 发到聊天或提交到仓库。`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
