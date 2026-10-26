import {createHash,createHmac,randomBytes} from 'node:crypto';

const WINDOW_MS=120000;
export const nativeTurnId=id=>typeof id==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const digest=(text,key)=>createHmac('sha256',key).update(text).digest('hex');
const milliseconds=value=>typeof value==='number' && Number.isFinite(value)?(value<1e12?value*1000:value):null;
export function receiptEvidence(prompt,turns,images=[]) {
  const salt=randomBytes(32).toString('hex');
  return {salt,promptDigest:digest(prompt,salt),baselineTurnIds:turns.map(t=>t.id).filter(Boolean),
    ...(images.length?{images:images.map(image=>({pathDigest:digest(image.path,salt),contentDigest:digest(image.digest,salt)}))}:{})};
}
function matchesParts(parts,evidence) {
  if(!Array.isArray(parts) || !parts.length)return false;
  const text=[],images=[];
  for(const part of parts){if(part.type==='text' && typeof part.text==='string')text.push(part.text);else if(['image','localImage'].includes(part.type))images.push(part);else return false;}
  if(digest(text.join('\n'),evidence.salt)!==evidence.promptDigest || images.length!==(evidence.images?.length||0))return false;
  return images.every((part,index)=>{
    const expected=evidence.images[index];
    if(part.type==='localImage' && typeof part.path==='string')return digest(part.path,evidence.salt)===expected.pathDigest;
    const url=part.url;
    if(typeof url!=='string' || url.length>14*1024*1024)return false;
    const data=url.match(/^data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/);if(!data)return false;
    return digest(createHash('sha256').update(Buffer.from(data[1],'base64')).digest('hex'),evidence.salt)===expected.contentDigest;
  });
}
function matchesInput(turn,watch) {
  const evidence=watch.evidence;
  if(!evidence?.salt || !evidence.promptDigest || !Array.isArray(evidence.baselineTurnIds))return false;
  if(evidence.baselineTurnIds.includes(turn.id))return false;
  const startedAt=milliseconds(turn.startedAt),submittedAt=watch.submittedAt??watch.createdAt;
  if(startedAt===null || !Number.isFinite(submittedAt) || startedAt<submittedAt-1000 || startedAt>submittedAt+WINDOW_MS)return false;
  return (turn.items||[]).some(item=>item.type==='userMessage' && (!item.clientId || item.clientId===watch.clientUserMessageId) && Array.isArray(item.content) && item.content.length>0 &&
    matchesParts(item.content,evidence));
}
export function receiptCandidates(turns,watch) {
  const native=turns.filter(t=>nativeTurnId(t.id));
  if(watch.confirmedTurnId)return {method:'turn',turns:native.filter(t=>t.id===watch.confirmedTurnId)};
  const exact=native.filter(t=>typeof watch.clientUserMessageId==='string' && (t.items||[]).some(i=>i.type==='userMessage' &&
    (i.id===watch.clientUserMessageId || i.clientId===watch.clientUserMessageId)));
  const anchor=turns.findIndex(t=>watch.evidence?.baselineTurnIds?.includes(t.id));
  const newer=anchor<0?native:turns.slice(0,anchor).filter(t=>nativeTurnId(t.id));
  return exact.length?{method:'client',turns:exact}:{method:'evidence',turns:newer.filter(t=>matchesInput(t,watch))};
}
export function receiptHistoryComplete(result,watch) {
  if(!result.page?.hasMore || !result.page.nextCursor)return true;
  if(watch.confirmedTurnId)return (result.turns||[]).some(t=>t.id===watch.confirmedTurnId);
  const submittedAt=watch.submittedAt??watch.createdAt;
  return (result.turns||[]).some(t=>watch.evidence?.baselineTurnIds?.includes(t.id) ||
    (milliseconds(t.startedAt)!==null && milliseconds(t.startedAt)<submittedAt-1000));
}
