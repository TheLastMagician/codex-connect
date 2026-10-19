import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const marketplace=path.join(root,'..','.work','model-switcher-marketplace');
const target=path.join(marketplace,'codex-model-switcher');
fs.mkdirSync(target,{recursive:true});
for(const name of ['plugin.json','mcp.json','.mcp.json','README.md','dist','assets','skills'])
  fs.cpSync(path.join(root,name),path.join(target,name),{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8'));
const compat={name:manifest.name,version:manifest.version,description:manifest.description,author:manifest.author,license:manifest.license,...manifest.extensions['com.openai']};
fs.mkdirSync(path.join(target,'.codex-plugin'),{recursive:true});
fs.writeFileSync(path.join(target,'.codex-plugin','plugin.json'),JSON.stringify(compat,null,2));
fs.mkdirSync(path.join(marketplace,'.agents','plugins'),{recursive:true});
fs.writeFileSync(path.join(marketplace,'.agents','plugins','marketplace.json'),JSON.stringify({name:'local-model-tools',interface:{displayName:'本机模型工具'},plugins:[{name:manifest.name,source:{source:'local',path:'./codex-model-switcher'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]},null,2));
console.log('本机插件源已准备：'+marketplace);
