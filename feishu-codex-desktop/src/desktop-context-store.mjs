import {readJson,writeJson} from './storage.mjs';

export const contextKey=context=>JSON.stringify([context?.pipePath,context?.threadId]);
const binding=context=>typeof context?.pipePath==='string' && context.pipePath && typeof context.threadId==='string' && context.threadId
  ?{pipePath:context.pipePath,threadId:context.threadId,...(typeof context.inputPipePath==='string'?{inputPipePath:context.inputPipePath}:{})}:null;

// Only callers that have passed a desktop probe enter this private history.
// A catalog result or a bot's selected destination is never a caller identity.
export function rememberDesktopContext(context) {
  const next=binding(context);if(!next)return;
  const previous=readJson('desktop-contexts.json',{bindings:[]}).bindings;
  const seen=new Set(),bindings=[next,...(Array.isArray(previous)?previous:[])].map(binding).filter(item=>{
    if(!item || seen.has(contextKey(item)))return false;seen.add(contextKey(item));return true;
  }).slice(0,16);
  if(JSON.stringify(bindings)!==JSON.stringify(previous))writeJson('desktop-contexts.json',{bindings});
}
export function publishDesktopContext(context,{expected}={}) {
  rememberDesktopContext(context);
  if(expected && contextKey(readJson('desktop-context.json',{}))!==contextKey(expected))return;
  writeJson('desktop-context.json',context);
}
