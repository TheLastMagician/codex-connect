import {createHmac,randomBytes} from 'node:crypto';

const WINDOW_MS=120000;
export const nativeTurnId=id=>typeof id==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const digest=(text,key)=>createHmac('sha256',key).update(text).digest('hex');
const milliseconds=value=>typeof value==='number' && Number.isFinite(value)?(value<1e12?value*1000:value):null;
export function receiptEvidence(prompt,turns) {
  const salt=randomBytes(32).toString('hex');
  return {salt,promptDigest:digest(prompt,salt),baselineTurnIds:turns.map(t=>t.id).filter(Boolean)};
}
function matchesInput(turn,watch) {
  const evidence=watch.evidence;
  if(!evidence?.salt || !evidence.promptDigest || !Array.isArray(evidence.baselineTurnIds))return false;
  if(evidence.baselineTurnIds.includes(turn.id))return false;
  const startedAt=milliseconds(turn.startedAt),submittedAt=watch.submittedAt??watch.createdAt;
  if(startedAt===null || !Number.isFinite(submittedAt) || startedAt<submittedAt-1000 || startedAt>submittedAt+WINDOW_MS)return false;
  return (turn.items||[]).some(item=>item.type==='userMessage' && (!item.clientId || item.clientId===watch.clientUserMessageId) && Array.isArray(item.content) && item.content.length>0 &&
    item.content.every(part=>part.type==='text' && typeof part.text==='string') &&
    digest(item.content.map(part=>part.text).join('\n'),evidence.salt)===evidence.promptDigest);
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
