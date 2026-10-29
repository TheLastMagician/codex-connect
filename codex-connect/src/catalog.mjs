import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const directory=typeof __dirname==='string'?__dirname:path.dirname(fileURLToPath(import.meta.url));
export function normalizePath(value) {
  return String(value||'').replace(/^\\\\\?\\/,'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
}
export function mapLocalThreads(catalog,projects) {
  const state=catalog.state||{};
  const assignments=state['thread-project-assignments']||{};
  const hints=state['thread-workspace-root-hints']||{};
  const hosts=state['thread-project-membership-host-ids']||{};
  const projectless=new Set(state['projectless-thread-ids']||[]);
  const local=projects.filter(p=>p.projectKind==='local' && (!p.hostId || p.hostId==='local'));
  const ids=new Map(local.map(p=>[p.projectId,p.projectId]));
  for(const [host,mapping] of Object.entries(state['app-server-project-id-by-legacy-project-id-by-host']||{})) {
    if(host.startsWith('local:')) for(const [legacy,current] of Object.entries(mapping)) {
      if(ids.has(legacy)) ids.set(current,legacy);
      else if(ids.has(current)) ids.set(legacy,current);
    }
  }
  return catalog.threads.filter(t=>!hosts[t.id] || hosts[t.id]==='local').map(t=>{
    const assigned=assignments[t.id];
    let projectId;
    if(assigned?.projectKind==='local') projectId=ids.get(assigned.projectId)||assigned.projectId;
    else if(t.project_id) projectId=ids.get(t.project_id)||t.project_id;
    else if(!projectless.has(t.id)) {
      const root=normalizePath(hints[t.id]||t.cwd);
      projectId=local.find(p=>normalizePath(p.path)===root)?.projectId;
    }
    return {id:t.id,title:t.title||t.id,cwd:t.cwd,updatedAt:t.updated_at,kind:'codex',hostId:'local',
      status:'notLoaded',...(projectId?{projectId}:{}),...(t.is_pinned?{catalogPinned:true}:{})};
  });
}
export async function readLocalThreads(projects,{codexHome=process.env.CODEX_HOME||path.join(homedir(),'.codex'),python=process.env.FEISHU_CODEX_PYTHON||'python'}={}) {
  const {stdout}=await execute(python,['-I',path.join(directory,'catalog.py'),codexHome],
    {windowsHide:true,timeout:10000,maxBuffer:8*1024*1024,encoding:'utf8'});
  return mapLocalThreads(JSON.parse(stdout),projects);
}
