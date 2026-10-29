import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MAX_INPUT_IMAGES=8,MAX_INPUT_IMAGE_BYTES=10*1024*1024;
export const imageInputError=(message,retryable=true)=>Object.assign(new Error(message),{code:'IMAGE_INPUT_ERROR',notSent:true,retryable});
export function imageExtension(buffer) {
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(buffer[0]===255 && buffer[1]===216 && buffer[2]===255)return 'jpg';
  if(/^GIF8[79]a$/.test(buffer.toString('ascii',0,6)))return 'gif';
  if(buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP')return 'webp';
}
export async function localImageInputs(images=[]) {
  if(!Array.isArray(images) || images.length>MAX_INPUT_IMAGES)throw imageInputError('每条消息最多支持 8 张图片，本条消息尚未发送。',false);
  const input=[],evidence=[];
  for(const file of images) {
    if(typeof file!=='string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || file.includes('\0'))throw imageInputError('图片附件路径无效，本条消息尚未发送。');
    let handle;
    try {
      if((await fs.lstat(file)).isSymbolicLink())throw Error('symbolic link');
      handle=await fs.open(file,'r');const stat=await handle.stat();
      if(!stat.isFile() || !stat.size || stat.size>MAX_INPUT_IMAGE_BYTES)throw Error('size');
      const buffer=await handle.readFile();if(buffer.length!==stat.size || !imageExtension(buffer))throw Error('format');
      input.push({type:'localImage',path:file});evidence.push({path:file,digest:createHash('sha256').update(buffer).digest('hex')});
    }catch{throw imageInputError('图片附件不可用或超过 10 MB，本条消息尚未发送。');}
    finally{await handle?.close();}
  }
  return {input,evidence};
}
