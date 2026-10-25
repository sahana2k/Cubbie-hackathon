import type Anthropic from '@anthropic-ai/sdk';

/** Preserve tool-call IDs and results across the provider-neutral agent loop. */
export function compatibleRequest(params: Anthropic.MessageCreateParamsNonStreaming) {
  const messages: Record<string, unknown>[] = [];
  if (params.system) messages.push({ role: 'system', content: typeof params.system === 'string' ? params.system : params.system.map(b => b.text).join('\n') });
  for (const message of params.messages) {
    if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
    const content: unknown[] = [];
    const calls: unknown[] = [];
    const results: unknown[] = [];
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'image') {
        const source = block.source;
        if (source.type !== 'base64' && source.type !== 'url') throw new Error('Upload the image directly.');
        content.push({ type: 'image_url', image_url: { url: source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url } });
      } else if (block.type === 'document') {
        const source = block.source;
        if (source.type === 'text') content.push({ type: 'text', text: source.data });
        else if (source.type === 'base64') content.push({ type: 'file', file: { filename: 'rubric.pdf', file_data: `data:${source.media_type};base64,${source.data}` } });
        else throw new Error('This provider needs an uploaded PDF, image, or text rubric.');
      } else if (block.type === 'tool_use') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      else if (block.type === 'tool_result') results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') });
    }
    if (content.length || calls.length) messages.push({ role: message.role, content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}) });
    messages.push(...results as Record<string, unknown>[]);
  }
  const choice = params.tool_choice;
  return { model: params.model, messages, max_completion_tokens: params.max_tokens,
    ...(params.tools?.length ? { tools: params.tools.map(t => {
      if (!('input_schema' in t)) throw new Error('Unsupported server tool');
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } };
    }) } : {}),
    ...(choice ? { tool_choice: choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type } : {}) };
}

export async function compatibleMessage(params: Anthropic.MessageCreateParamsNonStreaming, apiKey: string): Promise<Anthropic.Message> {
  const provider = process.env.LLM_PROVIDER;
  const bases: Record<string, string> = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1' };
  const base = bases[provider ?? ''] || process.env.LLM_BASE_URL;
  if (!base || new URL(base).protocol !== 'https:') throw new Error('Choose a provider with an HTTPS API endpoint.');
  const body: Record<string, unknown> = compatibleRequest(params);
  if (provider !== 'openai') { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
  const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`LLM request failed (${response.status}). Check the API key, model and file/tool support.`);
  const data = await response.json() as any;
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('The provider returned no message.');
  const content: Anthropic.ContentBlock[] = [];
  if (message.content) content.push({ type: 'text', text: message.content, citations: null });
  for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) } as Anthropic.ToolUseBlock);
  return { id: data.id ?? 'compatible', type: 'message', role: 'assistant', model: params.model, content,
    stop_reason: message.tool_calls?.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 } } as Anthropic.Message;
}
