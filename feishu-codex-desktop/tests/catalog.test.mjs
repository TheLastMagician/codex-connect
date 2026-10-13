import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {mapLocalThreads,normalizePath,readLocalThreads} from '../src/catalog.mjs';

test('catalog maps real project aliases, extended Windows paths, moved and independent chats',()=>{
  const projects=[{projectId:'legacy',projectKind:'local',path:'C:\\work\\app'},
    {projectId:'other',projectKind:'local',path:'C:\\work\\other'}];
  const state={'app-server-project-id-by-legacy-project-id-by-host':{'local:C:\\home':{legacy:'current'}},
    'thread-project-assignments':{moved:{projectKind:'local',projectId:'other'}},
    'projectless-thread-ids':['independent'], 'thread-project-membership-host-ids':{remote:'remote-ssh:test'}};
  const threads=mapLocalThreads({state,threads:[
    {id:'old',cwd:'\\\\?\\C:\\work\\app\\',title:'历史会话',updated_at:1},
    {id:'new',project_id:'current',cwd:'C:\\worktree'},
    {id:'moved',cwd:'C:\\work\\app'}, {id:'independent',cwd:'C:\\work\\app'},
    {id:'remote',cwd:'C:\\work\\app'}]},projects);
  assert.equal(normalizePath('\\\\?\\C:\\work\\app\\'),'c:/work/app');
  assert.deepEqual(threads.map(t=>[t.id,t.projectId]),[['old','legacy'],['new','legacy'],['moved','other'],['independent',undefined]]);
});

test('local catalog reads committed WAL data without modifying the chat database or exposing message bodies',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-catalog-'));
  const database=path.join(folder,'state_5.sqlite');
  try {
    execFileSync('python',['-I','-c',`import sqlite3,sys,os
c=sqlite3.connect(sys.argv[1]);c.execute('pragma journal_mode=wal')
c.execute('create table threads (id text,title text,cwd text,updated_at int,archived int,first_user_message text)')
c.execute('insert into threads values (?,?,?,?,?,?)',('older','历史会话','C:/work',1,0,'PRIVATE_BODY'))
c.execute('insert into threads values (?,?,?,?,?,?)',('archive','归档','C:/work',2,1,'PRIVATE_BODY'))
c.commit();os._exit(0)`,database],{windowsHide:true});
    fs.writeFileSync(path.join(folder,'session_index.jsonl'),JSON.stringify({id:'older',thread_name:'桌面中的标题'})+'\n');
    const before=fs.readFileSync(database);const wal=fs.readFileSync(database+'-wal');
    const rows=await readLocalThreads([],{codexHome:folder});
    assert.deepEqual(rows.map(t=>t.id),['older']);
    assert.equal(rows[0].title,'桌面中的标题');
    assert.ok(!JSON.stringify(rows).includes('PRIVATE_BODY'));
    assert.deepEqual(fs.readFileSync(database),before);assert.deepEqual(fs.readFileSync(database+'-wal'),wal);
  }finally {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'feishu-catalog-'));
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
