import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {dataDir} from './storage.mjs';
import {validImageKey} from './feishu-input.mjs';
import {MAX_INPUT_IMAGES,MAX_INPUT_IMAGE_BYTES,imageExtension,imageInputError} from './image-input.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,file)=>{const rel=path.relative(root,file);return rel && !rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel);};
export function createInboundImages({client,namespace,canRead,root=path.join(dataDir,'incoming-images'),report=()=>{}}) {
  const pending=new Map(),retryAt=new Map();
  return async(message,thread)=>{
    if(!message.images?.length)return [];
    const authorize=()=>{if(!canRead(message.openId))throw imageInputError('通道授权已撤销，图片和文字均未发送。');};
    authorize();
    if((thread.hostId||'local')!=='local')throw imageInputError('图片目前仅支持本机 Codex 会话，本条消息尚未发送。',false);
    if(message.images.length>MAX_INPUT_IMAGES)throw imageInputError('每条消息最多支持 8 张图片，本条消息尚未发送。',false);
    if(typeof message.id!=='string' || !/^om_[A-Za-z0-9_-]{1,250}$/.test(message.id))throw imageInputError('无法核验图片所属消息，本条消息尚未发送。');
    const paths=[];
    for(const image of message.images) {
      if(!validImageKey(image.key))throw imageInputError('图片资源标识无效，本条消息尚未发送。');
      authorize();
      const key=hash(JSON.stringify([namespace,message.chatId,message.id,image.key]));
      const folder=path.join(root,hash(namespace).slice(0,24));
      await fs.mkdir(folder,{recursive:true,mode:0o700});
      const anchor=await fs.realpath(root),actual=await fs.realpath(folder);
      if(!inside(anchor,actual))throw imageInputError('图片缓存目录不可用，本条消息尚未发送。');
      let saved;
      for(const ext of ['png','jpg','gif','webp']) {
        const file=path.join(folder,`${key}.${ext}`);
        try {
          const stat=await fs.lstat(file);
          if(stat.isSymbolicLink() || !stat.isFile() || stat.size>MAX_INPUT_IMAGE_BYTES || !inside(actual,await fs.realpath(file)))continue;
          if(imageExtension(await fs.readFile(file))===ext){saved=file;break;}
        }catch(error){if(error.code!=='ENOENT')throw imageInputError('图片缓存无法读取，本条消息尚未发送。');}
      }
      if(!saved) {
        if(retryAt.get(key)>Date.now())throw imageInputError('图片尚未下载成功，消息已保留；请检查飞书消息资源读取权限或网络连接。');
        let work=pending.get(key);
        if(!work) {
          work=(async()=>{
            authorize();let stream,timer,temp;
            try {
              const response=await client.im.v1.messageResource.get({path:{message_id:message.id,file_key:image.key},params:{type:'image'}},{timeout:15000});
              stream=response.getReadableStream();authorize();const chunks=[];let size=0;
              timer=setTimeout(()=>stream.destroy(Error('download timeout')),15000);
              for await(const chunk of stream){authorize();size+=chunk.length;if(size>MAX_INPUT_IMAGE_BYTES)throw imageInputError('图片超过 10 MB，本条消息尚未发送。',false);chunks.push(Buffer.from(chunk));}
              const buffer=Buffer.concat(chunks),ext=imageExtension(buffer);
              if(!ext)throw imageInputError('飞书图片下载失败或格式不支持，请检查应用的消息资源读取权限并发布生效；本条消息尚未发送。');
              authorize();const target=path.join(folder,`${key}.${ext}`);temp=target+'.'+randomUUID()+'.tmp';
              await fs.writeFile(temp,buffer,{mode:0o600,flag:'wx'});authorize();await fs.rename(temp,target);temp=null;return target;
            }catch(error){
              retryAt.set(key,Date.now()+30000);report({operation:'image_download',at:Date.now()});
              if(error.code==='IMAGE_INPUT_ERROR')throw error;
              throw imageInputError('飞书图片下载失败，消息已保留。请检查应用的消息资源读取权限并发布生效，或稍后等待网络恢复。');
            }finally{clearTimeout(timer);stream?.destroy();if(temp)await fs.unlink(temp).catch(()=>{});}
          })().finally(()=>pending.delete(key));pending.set(key,work);
        }
        saved=await work;
      }
      authorize();paths.push(saved);
    }
    return paths;
  };
}
