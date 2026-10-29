import {DesktopClient} from './desktop.mjs';
const client = new DesktopClient({pipePath:process.env.CODEX_APP_TOOLS_PIPE_PATH,threadId:process.env.CODEX_THREAD_ID});
try {
  const tools = await client.tools();
  const result = await client.call('list_threads',{limit:3});
  console.log(JSON.stringify({ok:true,tools:tools.map(tool=>tool.name),schemaVersion:result.schemaVersion,
    threadCount:(result.pinnedThreads?.length||0)+(result.threads?.length||0),
    hasCurrentChat:result.threads?.some(thread=>thread.id===process.env.CODEX_THREAD_ID)},null,2));
} finally {client.close();}
