import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'feishu-plugin-smoke',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['dist/server.cjs'],env:process.env});
try {
  await client.connect(transport);
  const tools=await client.listTools();
  const status=await client.callTool({name:'bridge_status',arguments:{}});
  const probe=await client.callTool({name:'desktop_probe',arguments:{}});
  if(probe.isError) throw new Error(probe.content[0].text);
  console.log(JSON.stringify({tools:tools.tools.map(t=>t.name),status:JSON.parse(status.content[0].text),probe:JSON.parse(probe.content[0].text)},null,2));
  if(process.argv.includes('--start')) {
    const start=await client.callTool({name:'start_bridge',arguments:{}});
    if(start.isError) throw new Error(start.content[0].text);
    console.log(start.content[0].text);
  }
}finally {await client.close();}
