import {secureDirectory,writeJson} from './storage.mjs';
import {DesktopClient} from './desktop.mjs';
const context={pipePath:process.env.CODEX_APP_TOOLS_PIPE_PATH,threadId:process.env.CODEX_THREAD_ID};
if(!context.pipePath || !context.threadId) throw new Error('请在 Codex 桌面提供的终端环境中绑定');
const desktop=new DesktopClient(context);
try {
  await desktop.call('list_threads',{limit:1});
  secureDirectory();writeJson('desktop-context.json',context);
  console.log('当前真实桌面会话已绑定。');
}finally {desktop.close();}
