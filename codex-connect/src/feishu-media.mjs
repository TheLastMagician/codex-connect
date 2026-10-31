import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const MAX_IMAGE_BYTES=10*1024*1024;
const imageKey=value=>/^img_[A-Za-z0-9_-]{1,250}$/.test(value);
const imageReasons={remote:'远程会话图片暂不支持回传',network_path:'不支持网络共享图片',external_url:'暂不支持外部图片链接',
  missing_project:'无法读取图片所属会话的项目目录',outside_root:'图片不在会话项目或临时、生成目录中',
  unsupported_format:'仅支持 PNG、JPEG、GIF、WEBP 图片',missing_file:'图片文件已不存在',read_denied:'没有权限读取图片文件',
  invalid_file:'图片不是普通文件或内容为空',too_large:'图片超过 10 MB',changing_file:'图片文件正在变化，请稍后查看',
  too_many:'单条回复最多显示 8 张图片',authorization:'通道授权已撤销',upload_failed:'飞书图片上传失败'};
const imageError=reason=>Object.assign(new Error(imageReasons[reason]),{mediaReason:reason});
function imageFailure(error) {
  const reason=error?.mediaReason && Object.hasOwn(imageReasons,error.mediaReason)?error.mediaReason:
    error?.code==='ENOENT'?'missing_file':['EACCES','EPERM'].includes(error?.code)?'read_denied':error?.code==='EISDIR'?'invalid_file':'upload_failed';
  const failure={...feishuFailure(error,'image'),reason};
  return {failure,text:imageReasons[reason]+(reason==='upload_failed' && failure.code?`（错误码 ${failure.code}）`:'')};
}
export function defaultFeishuImageRoots({platform=process.platform,home=os.homedir(),temporary=os.tmpdir()}={}) {
  const roots=[temporary,...['artifacts','visualizations','generated-images'].map(name=>path.join(home,'.codex',name))];
  if(platform==='win32')for(const directory of [home,temporary]) {
    const drive=path.win32.parse(directory).root;
    if(/^[a-z]:\\$/i.test(drive))roots.push(path.win32.join(drive,'temp'),path.win32.join(drive,'tmp'));
  }
  return [...new Set(roots)];
}
export function feishuFailure(error,operation='message') {
  const data=error?.response?.data||error?.data||error||{};
  const code=Number(data.code),status=Number(error?.response?.status);
  return {operation,...(Number.isInteger(code) && code!==0?{code}:{}),...(Number.isInteger(status) && status>0?{status}:{})};
}
export function feishuResult(result) {
  if(result?.code===0)return result;
  throw Object.assign(new Error('飞书拒绝了回复，请检查通道诊断'),{data:{code:result?.code}});
}

// Read image references only; examples inside fenced/inline code stay literal.
export function imageReferences(text) {
  const refs=[];let fence;let offset=0;
  for(const line of String(text).split(/(?<=\n)/)) {
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0] && marker[1].length>=fence.length)fence=null;offset+=line.length;continue;}
    if(fence){offset+=line.length;continue;}
    for(let i=0;i<line.length;i++) {
      if(line[i]==='`') {let j=i;while(line[j]==='`')j++;const close=line.indexOf(line.slice(i,j),j);if(close>=0){i=close+j-i-1;continue;}}
      if(line[i]!=='!' || line[i+1]!=='[' || line[i-1]==='\\')continue;
      const labelEnd=line.indexOf('](',i+2);if(labelEnd<0)continue;
      let cursor=labelEnd+2,depth=1;
      if(line[cursor]==='<') {
        const end=line.indexOf('>',cursor+1),tail=end<0?null:line.slice(end+1).match(/^\s*(?:"[^"]*"|'[^']*')?\s*\)/);
        if(!tail)continue;cursor=end+1+tail[0].length;depth=0;
      }
      while(cursor<line.length && depth) {
        if(line[cursor]==='\\' && /[()]/.test(line[cursor+1]||'')){cursor+=2;continue;}
        if(line[cursor]==='(')depth++;if(line[cursor]===')')depth--;cursor++;
      }
      if(depth)continue;
      let destination=line.slice(labelEnd+2,cursor-1).trim();
      if(destination.startsWith('<')){const end=destination.indexOf('>');if(end<0)continue;destination=destination.slice(1,end);}
      else destination=destination.replace(/\s+["'][^"']*["']\s*$/,'');
      refs.push({start:offset+i,end:offset+cursor,alt:line.slice(i+2,labelEnd),destination:destination.replace(/\\([()])/g,'$1')});i=cursor-1;
    }
    offset+=line.length;
  }
  return refs;
}
const inside=(root,file)=>{const relative=path.relative(root,file);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));};
function raster(buffer) {
  return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    (buffer[0]===255 && buffer[1]===216 && buffer[2]===255) || /^GIF8[79]a$/.test(buffer.toString('ascii',0,6)) ||
    (buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP');
}
export function createFeishuMedia({client,state,saveState,namespace='',canSend=()=>true,report=()=>{},now=Date.now,
  roots=defaultFeishuImageRoots(),resolveThread=async thread=>thread}) {
  const inFlight=new Map();
  async function upload(destination,thread,openId) {
    if(thread?.hostId && thread.hostId!=='local')throw imageError('remote');
    let file=destination;
    if(/^file:/i.test(file)){const url=new URL(file);if(url.hostname && url.hostname!=='localhost')throw imageError('network_path');file=fileURLToPath(url);}
    else {try{file=decodeURIComponent(file);}catch{}}
    if(/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file))throw imageError('external_url');
    if(/^[\\/]{2}|^\\\\[?.]/.test(file))throw imageError('network_path');
    if(!path.isAbsolute(file)) {if(!thread?.cwd)throw imageError('missing_project');file=path.resolve(thread.cwd,file);}
    const real=await fs.realpath(file);
    if(!/\.(png|jpe?g|gif|webp)$/i.test(real))throw imageError('unsupported_format');
    const allowed=await Promise.all([...roots,...(thread?.cwd?[thread.cwd]:[])].map(root=>fs.realpath(root).catch(()=>null)));
    if(!allowed.some(root=>root && inside(root,real)))throw imageError('outside_root');
    const handle=await fs.open(real,'r');let buffer;
    try {
      const stat=await handle.stat();if(!stat.isFile() || stat.size===0)throw imageError('invalid_file');
      if(stat.size>MAX_IMAGE_BYTES)throw imageError('too_large');
      buffer=Buffer.alloc(stat.size+1);let offset=0;
      while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
      if(offset!==stat.size || (await handle.stat()).size!==stat.size)throw imageError('changing_file');buffer=buffer.subarray(0,offset);
    }
    finally{await handle.close();}
    if(buffer.length>MAX_IMAGE_BYTES || !raster(buffer))throw imageError('unsupported_format');
    const digest=createHash('sha256').update(namespace).update(buffer).digest('hex');
    const cached=state.feishuImageUploads?.[digest];if(cached && imageKey(cached.key))return cached.key;
    if(inFlight.has(digest))return inFlight.get(digest);
    const work=(async()=>{
      if(!canSend(openId))throw imageError('authorization');
      const result=await client.im.v1.image.create({data:{image_type:'message',image:buffer}},{timeout:20000});
      if(result?.code!==undefined)feishuResult(result);
      const key=result?.image_key||result?.data?.image_key;if(!imageKey(key))throw imageError('upload_failed');
      state.feishuImageUploads={...state.feishuImageUploads,[digest]:{key,at:now()}};
      state.feishuImageUploads=Object.fromEntries(Object.entries(state.feishuImageUploads).slice(-200));saveState();return key;
    })().finally(()=>inFlight.delete(digest));inFlight.set(digest,work);return work;
  }
  const preparedKey=id=>id?createHash('sha256').update(namespace).update(id).digest('hex'):null;
  return {forget(id){const key=preparedKey(id);if(key && state.feishuPreparedReplies?.[key]){delete state.feishuPreparedReplies[key];saveState();}},
    async prepare(text,{thread,openId,deliveryId}={}) {
    const key=preparedKey(deliveryId),cached=key && state.feishuPreparedReplies?.[key];if(cached)return cached.text;
    text=String(text);const refs=imageReferences(text);let output='',previous=0,count=0;
    if(thread?.id && !thread.cwd && (!thread.hostId || thread.hostId==='local') && refs.some(ref=>!imageKey(ref.destination))) {
      try {
        const resolved=await resolveThread(thread);
        if(resolved?.id===thread.id && (resolved.hostId||'local')===(thread.hostId||'local') && typeof resolved.cwd==='string' && path.isAbsolute(resolved.cwd) && !/^[\\/]{2}/.test(resolved.cwd))
          thread={...thread,cwd:resolved.cwd};
      }catch{/* A failed project lookup must not prevent temporary/generated images or the text reply. */}
    }
    for(const ref of refs) {
      output+=text.slice(previous,ref.start);previous=ref.end;
      if(imageKey(ref.destination)){output+=text.slice(ref.start,ref.end);continue;}
      try {
        if(++count>8)throw imageError('too_many');
        const key=await upload(ref.destination,thread,openId);
        output+=`![${ref.alt.replace(/[\[\]<>]/g,'').slice(0,120)||'图片'}](${key})`;
      }catch(error){const {failure,text}=imageFailure(error);report({...failure,at:now()});output+=`（图片暂未发送：${text}；文字回复继续显示）`;}
    }
    output+=text.slice(previous);
    if(key){state.feishuPreparedReplies={...state.feishuPreparedReplies,[key]:{text:output}};saveState();}
    return output;
  }};
}
