import {build} from 'esbuild';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
for(const entry of ['server','bridge','setup','wechat-auth-worker','autostart','responses-compat-daemon']) {
  await build({entryPoints:[`src/${entry}.mjs`],outfile:`dist/${entry}.cjs`,bundle:true,platform:'node',
    target:'node20',format:'cjs',legalComments:'linked',external:['bufferutil','utf-8-validate'],
    define:{'import.meta.url':'__filename'},minify:false});
}
await copyFile('src/catalog.py','dist/catalog.py');
await copyFile('src/provider-config.py','dist/provider-config.py');
await copyFile('src/discover-desktop.ps1','dist/discover-desktop.ps1');
for(const name of ['dashboard.html','dashboard.js','dashboard.css'])await copyFile('web/'+name,'dist/'+name);
await copyFile('assets/icon.png','dist/dashboard-icon.png');
await copyFile('assets/entrypoint-icon.svg','dist/entrypoint-icon.svg');
const app=await build({entryPoints:['web/settings-panel.mjs'],bundle:true,platform:'browser',target:'es2022',format:'iife',minify:true,write:false});
const script=app.outputFiles[0].text+'\n'+await readFile('web/dashboard.js','utf8');
let html=await readFile('web/dashboard.html','utf8');
const css=await readFile('web/dashboard.css','utf8');
const icon='data:image/png;base64,'+(await readFile('assets/icon.png')).toString('base64');
html=html.replace('<link rel="stylesheet" href="/dashboard.css">',()=>'<style>'+css+'</style>')
  .replace('<script src="/dashboard.js" defer></script>','').replaceAll('/icon.png',icon)
  .replace('</body>',()=>'<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body>');
await writeFile('dist/settings-panel.html',html);
