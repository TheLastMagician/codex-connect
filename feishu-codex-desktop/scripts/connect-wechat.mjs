import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'codex-connect-wechat',version:'0.2.0'});
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.cjs'],env:process.env}));
  const name=process.argv.includes('--status')?'wechat_login_status':'wechat_login';
  const result=await client.callTool({name,arguments:name==='wechat_login'?{refresh:process.argv.includes('--refresh')}:{}});
  if(result.isError)throw new Error(result.content[0].text);
  console.log(result.content[0].text);
}finally{await client.close();}
