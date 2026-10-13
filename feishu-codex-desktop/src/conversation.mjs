export function conversationMessages(result) {
  const messages=[];
  // Desktop returns the newest turn first, with items ordered within each turn.
  for(const turn of [...(result.turns||[])].reverse()) {
    for(const item of turn.items||[]) {
      if(item.type==='userMessage') {
        const text=Array.isArray(item.content)?item.content.map(part=>
          part.type==='text'?part.text||'':'[附件]').filter(Boolean).join('\n'):item.text||'';
        messages.push({role:'user',text:text||'[非文字消息]'});
      } else if(item.type==='agentMessage' && item.text) {
        messages.push({role:'assistant',text:item.text,phase:item.phase});
      }
    }
    if(turn.error?.message)messages.push({role:'error',text:`执行错误：${turn.error.message}`});
  }
  return messages;
}

export function messageLabel(message,index) {
  const role=message.role==='user'?'你':message.role==='error'?'执行错误':
    message.phase==='commentary'?'Codex · 进度':'Codex';
  return `${role} · 消息 ${message.messageNumber??index+1}${message.continuation?'（续）':''}`;
}

export function renderConversation(messages) {
  return messages.length?messages.map((message,index)=>
    `**${messageLabel(message,index)}**\n\n${message.text}`).join('\n\n──────────\n\n'):'暂无可显示的对话消息。';
}
