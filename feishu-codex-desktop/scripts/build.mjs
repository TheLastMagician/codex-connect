import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
for(const entry of ['server','bridge','setup','wechat-auth-worker','autostart']) {
  await build({entryPoints:[`src/${entry}.mjs`],outfile:`dist/${entry}.cjs`,bundle:true,platform:'node',
    target:'node20',format:'cjs',legalComments:'linked',external:['bufferutil','utf-8-validate'],
    define:{'import.meta.url':'__filename'},minify:false});
}
await copyFile('src/catalog.py','dist/catalog.py');
