import readline from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {secureDirectory,readJson,writeJson,dataDir} from './storage.mjs';
import {beginWechatLogin} from './wechat-auth.mjs';
import {configureAssistant,assistantSettings} from './assistant.mjs';
import {configureAutostart} from './autostart-settings.mjs';

async function hiddenQuestion(prompt) {
  let muted=false;
  const output=new Writable({write(chunk,encoding,next){if(!muted) process.stdout.write(chunk);next();}});
  const input=readline.createInterface({input:process.stdin,output,terminal:process.stdin.isTTY});
  const answer=input.question(prompt);muted=true;
  try{return (await answer).trim();}finally{input.close();process.stdout.write('\n');}
}
async function main() {
  if(process.argv[2]==='autostart') {
    if(!['on','off'].includes(process.argv[3]))throw new Error('使用 node dist/setup.cjs autostart on 或 off');
    console.log(JSON.stringify(configureAutostart(process.argv[3]==='on',{bundleDir:__dirname}),null,2));return;
  }
  if(process.argv[2]==='assistant') {
    const previous=assistantSettings();const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    let baseUrl,model,reasoningEffort;
    try {
      baseUrl=(await rl.question('助手接口地址（回车保留）: ')).trim()||previous.baseUrl;
      model=(await rl.question('助手模型 ID（回车保留）: ')).trim()||previous.model;
      reasoningEffort=(await rl.question('助手推理强度（回车保留，可留空）: ')).trim()||previous.reasoningEffort;
    }finally{rl.close();}
    const apiKey=await hiddenQuestion('助手 API Key（隐藏输入，回车保留）: ')||previous.apiKey;
    console.log(JSON.stringify(configureAssistant({baseUrl,model,reasoningEffort,apiKey,enabled:true}),null,2));return;
  }
  if(process.argv[2]==='wechat') {
    const login=await beginWechatLogin({refresh:process.argv.includes('--refresh')});
    console.log(JSON.stringify(login,null,2));
    console.log('用微信扫一扫二维码图片并确认，然后回到 Codex 启动桌面聊天桥接。');return;
  }
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
