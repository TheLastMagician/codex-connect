import fs from 'node:fs';
import path from 'node:path';

export async function listProjects(client) {
  const projects=[],seen=new Set();let cursor;
  do {
    const result=await client.request('project/list',{limit:100,...(cursor?{cursor}:{})});
    for(const project of result.data||[]) {
      if(seen.has(project.id))continue;seen.add(project.id);
      const roots=(project.roots||[]).map(root=>root.path).filter(root=>typeof root==='string'&&path.isAbsolute(root));
      if(roots.length)projects.push({id:project.id,name:project.name,roots});
    }
    const next=result.nextCursor;if(next===cursor&&next)throw new Error('项目列表分页未前进，请刷新。');cursor=next;
  }while(cursor);
  return projects;
}
export function projectChoices(projects) {
  return projects.flatMap(project=>project.roots.map(cwd=>({projectId:project.id,cwd,label:`${project.name} · ${cwd}`})));
}
export function projectDirectory(project,cwd) {
  if(!project)throw new Error('所选 Codex 项目已不存在，请刷新项目列表。');
  const roots=project.roots.map(root=>typeof root==='string'?root:root.path);
  const selected=cwd||roots[0];
  if(!selected||!path.isAbsolute(selected)||!roots.some(root=>path.resolve(root)===path.resolve(selected)))throw new Error('工作目录必须来自所选 Codex 项目。');
  if(!fs.existsSync(selected)||!fs.statSync(selected).isDirectory())throw new Error('所选项目的本机目录不存在，请先在 Codex 中更新该项目。');
  return path.resolve(selected);
}
