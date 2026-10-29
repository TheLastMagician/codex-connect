// Read-only live verification; replies are captured locally, never sent to Feishu.
import {DesktopClient} from '../src/desktop.mjs';
import {Router} from '../src/router.mjs';
import {readJson} from '../src/storage.mjs';
import assert from 'node:assert/strict';
const desktop=new DesktopClient(readJson('desktop-context.json',{}));
const allowed=new Set(['list_threads','list_projects','list_archived_threads']);
const guarded={call:(name,args)=>{
  assert.ok(allowed.has(name),`Preview attempted a mutation: ${name}`);return desktop.call(name,args);
}};
const replies=[];const state={};
const router=new Router({desktop:guarded,state,saveState:()=>{},send:async(_chat,text)=>replies.push(text)});
const run=text=>router.handle({openId:'preview',chatId:'preview',text});
try {
  await run('/chats');const session=state.sessions['preview:preview'];
  assert.ok(replies.at(-1).includes('选择会话：/use 1'));
  const total=session.threads.length;
  if(total>10) {
    await run('/next');assert.ok(replies.at(-1).includes('选择会话：/use 11'));
    await run('/prev');assert.equal(session.view.page,1);
    await run('/page 2');assert.equal(session.view.page,2);
  }
  await run('/projects');const projects=session.projects.length;
  if(projects) {assert.ok(replies.at(-1).includes('/project 1'));await run('/project 1');assert.ok(session.view.projectId);}
  await run('/archived');const archivedFirst=session.threads.length;
  if(session.archiveCursor) {await run('/next');await run('/prev');assert.equal(session.view.page,1);}
  await run('/help');assert.ok(replies.at(-1).includes('/page 2'));
  console.log(JSON.stringify({ok:true,chats:total,projects,archivedFirst,repliesChecked:replies.length,mutationCalls:0}));
}finally {desktop.close();}
