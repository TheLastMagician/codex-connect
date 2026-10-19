import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {connectionSettings,SETTINGS_URI} from '../src/settings-panel.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('native plugin settings link to the complete panel without returning credentials',()=>{
  const settings=connectionSettings(true);assert.deepEqual(settings.values,{autostart:true});
  assert.ok(settings.layout[0].items.some(item=>item.tool==='open_settings'));
  assert.deepEqual(Object.keys(settings.schema.properties),['autostart']);
});

test('packaged MCP exposes global and thread entrypoints, structured settings and a self-contained App',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-panel-test-'));
  const client=new Client({name:'settings-panel-fixture',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/server.cjs')],stderr:'pipe',
    env:{...process.env,FEISHU_CODEX_DATA_DIR:folder,CODEX_HOME:path.join(folder,'codex'),FEISHU_APP_ID:'',FEISHU_APP_SECRET:''}});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    for(const [name,type,title] of [['open_settings','global','Codex 连接'],['open_thread_settings','thread','通道配置']]) {
      const tool=tools.find(t=>t.name===name);assert.equal(tool.title,title);assert.equal(tool._meta.ui.resourceUri,SETTINGS_URI);
      assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type}]);
    }
    assert.deepEqual(tools.find(t=>t.name==='settings_request')._meta.ui.visibility,['app']);
    assert.equal(client.getServerCapabilities().experimental['openai/settings'].readTool,'read_connection_settings');
    const settings=await client.callTool({name:'read_connection_settings',arguments:{}});assert.equal(settings.structuredContent.values.autostart,false);
    const resources=await client.listResources();assert.equal(resources.resources[0].uri,SETTINGS_URI);
    const result=await client.readResource({uri:SETTINGS_URI});const app=result.contents[0];
    assert.equal(app.mimeType,'text/html;profile=mcp-app');assert.equal(app._meta['openai/ui'].preferredDisplayMode,'fullscreen');
    assert.deepEqual(app._meta.ui.csp.connectDomains,[]);
    assert.ok(app.text.includes('codexConnectPanel'));assert.ok(app.text.includes('添加机器人'));assert.ok(app.text.includes('微信 ClawBot'));
    assert.doesNotMatch(app.text,/<iframe|src="\/|href="\/|http:\/\/127\.0\.0\.1|#token=/);
    const opened=await client.callTool({name:'open_settings',arguments:{}});assert.equal(opened.structuredContent.ready,true);
    assert.ok(!opened.structuredContent.url);
  }finally {
    try {const lock=JSON.parse(fs.readFileSync(path.join(folder,'bridge.lock'),'utf8'));process.kill(lock.pid);}catch{}
    await client.close();
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'codex-panel-test-'));
    fs.rmSync(folder,{recursive:true,force:true,maxRetries:15,retryDelay:50});
  }
});
