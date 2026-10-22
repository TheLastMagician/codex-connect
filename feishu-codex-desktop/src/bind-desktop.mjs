import {secureDirectory} from './storage.mjs';
import {DesktopClient} from './desktop.mjs';
import {publishDesktopContext} from './desktop-context-store.mjs';
const context={pipePath:process.env.CODEX_APP_TOOLS_PIPE_PATH,threadId:process.env.CODEX_THREAD_ID};
if(!context.pipePath || !context.threadId) throw new Error('请在 Codex 桌面提供的终端环境中绑定');
const desktop=new DesktopClient(context,{recover:false});
try {
  await desktop.probe();
  secureDirectory();publishDesktopContext(context);
  console.log('当前真实桌面会话已绑定。');
}finally {desktop.close();}
