import { describe, expect, it } from 'vitest';
import { compatibleRequest } from '../src/claude/compatible';

describe('provider adapter', () => {
  it('preserves tool identity, arguments, results and forced routing across turns', () => {
    const request = compatibleRequest({ model: 'chosen-model', max_tokens: 100, system: 'system',
      tools: [{ name: 'route', input_schema: { type: 'object', properties: {} } }], tool_choice: { type: 'tool', name: 'route' },
      messages: [{ role: 'user', content: 'I will do slides' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'route', input: { agents: ['planner'] } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'accepted' }] }] });
    expect(request.model).toBe('chosen-model');
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'route' } });
    expect(request.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call1', function: { name: 'route', arguments: '{"agents":["planner"]}' } }] });
    expect(request.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call1', content: 'accepted' });
  });
  it('converts text rubrics, PDFs and images without discarding attachments', () => {
    const request = compatibleRequest({ model: 'vision', max_tokens: 100, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'rubric text' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    ] }] });
    expect(request.messages[0].content).toEqual([
      { type: 'text', text: 'rubric text' },
      { type: 'file', file: { filename: 'rubric.pdf', file_data: 'data:application/pdf;base64,cGRm' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
    ]);
  });
});
