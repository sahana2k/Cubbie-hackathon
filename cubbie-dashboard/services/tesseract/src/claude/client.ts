import { compatibleMessage } from './compatible';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { log } from '../core/log';

export type MessagesCreate = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

let override: MessagesCreate | null = null;
let client: Anthropic | null = null;

/** Tests inject a fake here so the agent loop runs without network access. */
export function setClaudeForTests(fn: MessagesCreate | null) { override = fn; }

export async function createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  if (override) return override(params);
  if (process.env.LLM_PROVIDER && process.env.LLM_PROVIDER !== 'anthropic') return compatibleMessage(params, config.llmKey);
  if (!client) client = new Anthropic({ apiKey: config.llmKey, maxRetries: 3, timeout: 90_000 });
  const started = Date.now();
  const res = await client.messages.create(params);
  log.debug(`claude ${params.model} ${Date.now() - started}ms in=${res.usage.input_tokens} out=${res.usage.output_tokens} stop=${res.stop_reason}`);
  return res;
}

export function textOf(msg: Anthropic.Message): string {
  return msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
}
