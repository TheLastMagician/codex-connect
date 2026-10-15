import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
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
