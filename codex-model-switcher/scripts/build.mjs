import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const app=await build({entryPoints:[path.join(root,'web/panel.mjs')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,minify:true});
const script=app.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=fs.readFileSync(path.join(root,'web/panel.html'),'utf8').replace('/* STYLES */',fs.readFileSync(path.join(root,'web/panel.css'),'utf8')).replace('/* SCRIPT */',()=>script);
fs.writeFileSync(path.join(dist,'panel.html'),html);
// Bundled CommonJS uses __dirname; keep the unused ESM fallback independent of the build machine.
await build({entryPoints:[path.join(root,'src/server.mjs')],outfile:path.join(dist,'server.cjs'),bundle:true,platform:'node',target:'node20',format:'cjs',define:{'import.meta.url':JSON.stringify('file:///codex-model-switcher/src/server.mjs')}});
await build({entryPoints:[path.join(root,'src/scheduler-worker.mjs')],outfile:path.join(dist,'scheduler.cjs'),bundle:true,platform:'node',target:'node20',format:'cjs',define:{'import.meta.url':JSON.stringify('file:///codex-model-switcher/src/scheduler-worker.mjs')}});
console.log('已构建 MCP 服务与供应商面板。');
