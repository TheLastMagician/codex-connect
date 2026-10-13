export function conversationMessages(result) {
  const messages=[];
  // Desktop returns the newest turn first, with items ordered within each turn.
  for(const turn of [...(result.turns||[])].reverse()) {
    const items=turn.items||[];
    for(const [index,item] of items.entries()) {
      if(item.type==='userMessage') {
        const text=Array.isArray(item.content)?item.content.map(part=>
          part.type==='text'?part.text||'':'[附件]').filter(Boolean).join('\n'):item.text||'';
        messages.push({role:'user',text:text||'[非文字消息]'});
      } else if(index===0 && item.type==='functionCallOutput' && item.namespace==='codex_app' && item.name==='send_message_to_thread'
        && !items.some(other=>other.type==='userMessage')) {
        // Remote desktop prompts are represented as the initial delegation event.
        // Extract only its user input, never ordinary tool output or routing metadata.
        const output=item.output;const text=output?.text;
        if(typeof text==='string') {
          const prefix=/^<codex_delegation>\s*<source_thread_id>[^<]*<\/source_thread_id>\s*<input>/;
          const match=text.match(/^<codex_delegation>\s*<source_thread_id>[^<]*<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
          const input=match?.[1]??(output.truncated && prefix.test(text)?text.replace(prefix,''):null);
          if(input!==null)messages.push({role:'user',text:input+(output.truncated?'\n\n[消息过长，已截断；完整内容请在桌面查看。]':'')});
        }
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
