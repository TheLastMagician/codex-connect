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
const app=await build({entryPoints:['web/settings-panel.mjs'],bundle:true,platform:'browser',target:'es2022',format:'iife',minify:true,write:false});
const script=app.outputFiles[0].text+'\n'+await readFile('web/dashboard.js','utf8');
let html=await readFile('web/dashboard.html','utf8');
const css=await readFile('web/dashboard.css','utf8')+`
body{padding:var(--safe-top,0px) var(--safe-right,0px) var(--safe-bottom,0px) var(--safe-left,0px)}
:root[data-theme=dark]{color-scheme:dark;color:#e5ece9;background:#17211e;--line:#364740;--muted:#a4b6ae;--accent:#2b9c85}
[data-theme=dark] .bot,[data-theme=dark] .panel,[data-theme=dark] dialog{background:#21312b;color:#e5ece9}
[data-theme=dark] .target,[data-theme=dark] .dialog-footer{background:#192820}
[data-theme=dark] .desktop-status,[data-theme=dark] .count,[data-theme=dark] .badge{background:#2b4035;color:#cee6d8;border-color:#4a6055}
[data-theme=dark] .channel-icon{background:#243e5c;color:#c9ddff}[data-theme=dark] .channel-icon.wechat{background:#24533c;color:#b4f1c8}
[data-theme=dark] button,[data-theme=dark] input,[data-theme=dark] select{background:#293e34;color:#e5ece9;border-color:#4a6055}
[data-theme=dark] button.primary{background:#087f6d;color:white}[data-theme=dark] .notice{background:#303c2a;color:#e2ead9}
`;
const icon='data:image/png;base64,'+(await readFile('assets/icon.png')).toString('base64');
html=html.replace('<link rel="stylesheet" href="/dashboard.css">',()=>'<style>'+css+'</style>')
  .replace('<script src="/dashboard.js" defer></script>','').replaceAll('/icon.png',icon)
  .replace('</body>',()=>'<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body>');
await writeFile('dist/settings-panel.html',html);
