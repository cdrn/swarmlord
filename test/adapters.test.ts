import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { parseResponse, toAnthropicMessage, toStopReason } from '../src/adapters/anthropic.js'
import { OpenAIAdapter } from '../src/adapters/openai.js'
import { GeminiAdapter } from '../src/adapters/gemini.js'
import { MockAdapter, turnOf } from '../src/adapters/mock.js'
import type { NeutralMessage, StopReason, ToolDef, TurnRequest } from '../src/adapters/types.js'

const emptyRequest: TurnRequest = { system: 'sys', messages: [], tools: [] }

/**
 * Replace a nested method on an adapter's private `client` with a spy that
 * records the wire body it was called with and returns a canned response —
 * no network. Path is dotted, e.g. 'chat.completions.create'. Works on
 * whatever object shape the adapter constructed for its client field.
 */
function stubClient(
  adapter: object,
  path: string,
  canned: unknown,
): { calls: unknown[] } {
  const client = (adapter as { client?: Record<string, unknown> }).client
  if (client === undefined) throw new Error('adapter has no private `client` field to stub')
  const parts = path.split('.')
  const method = parts.pop()!
  let target: Record<string, unknown> = client
  for (const p of parts) {
    const next = target[p]
    if (next === undefined || typeof next !== 'object') {
      // Build the nesting if the SDK lazily creates it — keeps the stub robust.
      target[p] = {}
    }
    target = target[p] as Record<string, unknown>
  }
  const calls: unknown[] = []
  target[method] = (body: unknown) => {
    calls.push(body)
    return Promise.resolve(canned)
  }
  return { calls }
}

const oneTool: ToolDef[] = [
  { name: 'post', description: 'post a finding', inputSchema: { type: 'object', properties: {} } },
]

describe('toAnthropicMessage', () => {
  it('maps an empty assistant turn to a non-empty content array with a placeholder', () => {
    const mapped = toAnthropicMessage({ role: 'assistant', content: '', toolCalls: [] })
    expect(mapped.role).toBe('assistant')
    const content = mapped.content as Anthropic.ContentBlockParam[]
    expect(content).toHaveLength(1)
    expect(content[0]).toEqual({ type: 'text', text: '(no output this turn)' })
  })

  it('does not emit whitespace-only text as a text block', () => {
    const mapped = toAnthropicMessage({ role: 'assistant', content: '  \n\t ', toolCalls: [] })
    const content = mapped.content as Anthropic.ContentBlockParam[]
    expect(content.some((b) => b.type === 'text' && b.text.trim() === '' && b.text !== '(no output this turn)')).toBe(
      false,
    )
    // With no tool calls either, the placeholder keeps the turn wire-valid.
    expect(content).toEqual([{ type: 'text', text: '(no output this turn)' }])
  })

  it('does not add a placeholder when tool calls are present', () => {
    const mapped = toAnthropicMessage({
      role: 'assistant',
      content: ' ',
      toolCalls: [{ id: 'tc-1', name: 'post', input: { body: 'x' } }],
    })
    const content = mapped.content as Anthropic.ContentBlockParam[]
    expect(content).toEqual([{ type: 'tool_use', id: 'tc-1', name: 'post', input: { body: 'x' } }])
  })

  it('replays providerContent verbatim (identity, no reconstruction)', () => {
    const sentinel = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig-123' },
      { type: 'text', text: 'visible' },
      { type: 'tool_use', id: 'tc-9', name: 'idle', input: {} },
    ]
    // Verbatim replay only when the turn was produced by THIS adapter — the
    // providerAdapter tag must match the adapter name passed to the mapper.
    const mapped = toAnthropicMessage(
      {
        role: 'assistant',
        content: 'visible',
        toolCalls: [{ id: 'tc-9', name: 'idle', input: {} }],
        providerContent: sentinel,
        providerAdapter: 'anthropic:test-model',
      },
      'anthropic:test-model',
    )
    expect(mapped.role).toBe('assistant')
    // Same array object — signatures on thinking blocks are load-bearing.
    expect(mapped.content).toBe(sentinel)
  })

  it('reconstructs (does not replay) providerContent tagged by another provider', () => {
    const foreign = [{ type: 'reasoning', text: 'not anthropic shaped' }]
    const mapped = toAnthropicMessage(
      {
        role: 'assistant',
        content: 'hello',
        toolCalls: [{ id: 'tc-1', name: 'post', input: { body: 'x' } }],
        providerContent: foreign,
        providerAdapter: 'openai:gpt-5',
      },
      'anthropic:claude-opus-4-8',
    )
    // Cross-provider: must NOT pass the foreign blocks through — rebuild instead.
    expect(mapped.content).not.toBe(foreign)
    const blocks = mapped.content as Array<{ type: string }>
    expect(blocks.some(b => b.type === 'text')).toBe(true)
    expect(blocks.some(b => b.type === 'tool_use')).toBe(true)
  })

  it('maps tool_results to a user turn with matching tool_use_id and is_error', () => {
    const mapped = toAnthropicMessage({
      role: 'tool_results',
      results: [
        { toolCallId: 'tc-1', content: 'ok' },
        { toolCallId: 'tc-2', content: 'boom', isError: true },
      ],
    })
    expect(mapped.role).toBe('user')
    expect(mapped.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tc-1', content: 'ok', is_error: false },
      { type: 'tool_result', tool_use_id: 'tc-2', content: 'boom', is_error: true },
    ])
  })

  it('a mapped history with a leading user NeutralMessage never starts with an assistant message', () => {
    const history: NeutralMessage[] = [
      { role: 'user', content: 'wake up' },
      { role: 'assistant', content: '', toolCalls: [] },
      { role: 'user', content: 'auto-idled' },
    ]
    const mapped = history.map(toAnthropicMessage)
    expect(mapped[0]?.role).toBe('user')
    // And every assistant entry stays wire-valid (non-empty content).
    for (const m of mapped) {
      if (m.role === 'assistant') {
        expect((m.content as Anthropic.ContentBlockParam[]).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('toStopReason', () => {
  const table: Array<[string | null, StopReason]> = [
    ['end_turn', 'complete'],
    ['tool_use', 'complete'],
    ['stop_sequence', 'complete'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
    ['model_context_window_exceeded', 'other'],
    [null, 'other'],
  ]

  it.each(table)('maps %s to %s', (raw, expected) => {
    expect(toStopReason(raw)).toBe(expected)
  })
})

describe('parseResponse', () => {
  it('extracts text and tool calls, carries the full content array as providerContent', () => {
    const content = [
      { type: 'thinking', thinking: 'let me think', signature: 'sig-abc' },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'tool_use', id: 'tc-1', name: 'post', input: { body: 'x' } },
    ]
    const response = {
      content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34 },
    } as unknown as Anthropic.Message

    const result = parseResponse(response)
    expect(result.text).toBe('hello world')
    expect(result.toolCalls).toEqual([{ id: 'tc-1', name: 'post', input: { body: 'x' } }])
    expect(result.providerContent).toBe(content)
    expect(result.stopReason).toBe('complete')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('maps max_tokens through to the neutral stopReason', () => {
    const response = {
      content: [],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 2 },
    } as unknown as Anthropic.Message
    expect(parseResponse(response).stopReason).toBe('max_tokens')
  })
})

describe('MockAdapter', () => {
  it('defaults stopReason to complete when the handler does not set it', async () => {
    const adapter = new MockAdapter(() => turnOf([{ name: 'idle', input: {} }]))
    const result = await adapter.turn(emptyRequest)
    expect(result.stopReason).toBe('complete')
  })

  it('preserves a stopReason set by the handler', async () => {
    const adapter = new MockAdapter(() => ({ ...turnOf([]), stopReason: 'max_tokens' }))
    const result = await adapter.turn(emptyRequest)
    expect(result.stopReason).toBe('max_tokens')
  })
})

// ---------------------------------------------------------------------------
// Cross-provider adapters. No network: we construct the adapter, stub its
// private SDK client method to capture the request body and return a canned
// response, and assert the neutral→wire mapping and the response→TurnResult
// parse. A fake apiKey keeps SDK construction offline.
// ---------------------------------------------------------------------------

describe('OpenAIAdapter', () => {
  it('names itself openai:<model> and carries its manifest', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      model: 'gpt-5',
      manifest: { provider: 'openai', strengths: ['tools'], cautions: ['strict json'], costClass: 'moderate' },
    })
    expect(adapter.name).toBe('openai:gpt-5')
    expect(adapter.manifest?.provider).toBe('openai')
    expect(adapter.manifest?.cautions).toContain('strict json')
  })

  it('maps a TurnRequest to the chat.completions wire shape', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-5' })
    const canned = {
      choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }
    const spy = stubClient(adapter, 'chat.completions.create', canned)

    await adapter.turn({
      system: 'be terse',
      tools: oneTool,
      messages: [
        { role: 'user', content: 'do the thing' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'tc-1', name: 'post', input: { body: 'x' } }],
          providerAdapter: 'openai:gpt-5',
        },
        { role: 'tool_results', results: [{ toolCallId: 'tc-1', content: 'ok' }] },
      ],
    })

    expect(spy.calls).toHaveLength(1)
    const body = spy.calls[0] as {
      model: string
      messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>
      tools?: Array<{ type: string; function: { name: string } }>
    }
    expect(body.model).toBe('gpt-5')
    // system prompt becomes a system/developer message ahead of the turns
    expect(body.messages[0]?.role === 'system' || body.messages[0]?.role === 'developer').toBe(true)
    expect(JSON.stringify(body.messages[0]?.content)).toContain('be terse')
    // the user turn is present
    expect(body.messages.some(m => m.role === 'user')).toBe(true)
    // the tool_results turn becomes a role:'tool' message keyed by tool_call_id
    const toolMsg = body.messages.find(m => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('tc-1')
    // tools are mapped to the function-tool shape
    expect(body.tools?.[0]?.type).toBe('function')
    expect(body.tools?.[0]?.function.name).toBe('post')
  })

  it('parses a canned response into a TurnResult (text, toolCalls, stopReason, usage)', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-5' })
    const canned = {
      choices: [
        {
          message: {
            content: 'here you go',
            tool_calls: [
              { id: 'call_9', type: 'function', function: { name: 'post', arguments: '{"body":"hello"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    }
    stubClient(adapter, 'chat.completions.create', canned)

    const result = await adapter.turn(emptyRequest)
    expect(result.text).toBe('here you go')
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'post', input: { body: 'hello' } }])
    expect(result.stopReason).toBe('complete')
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
  })

  it('maps finish_reason length to max_tokens and a content filter to refusal', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-5' })
    stubClient(adapter, 'chat.completions.create', {
      choices: [{ message: { content: '', tool_calls: [] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    })
    expect((await adapter.turn(emptyRequest)).stopReason).toBe('max_tokens')

    const refuser = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-5' })
    stubClient(refuser, 'chat.completions.create', {
      choices: [{ message: { content: 'I cannot help with that.', tool_calls: [] }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    })
    expect((await refuser.turn(emptyRequest)).stopReason).toBe('refusal')
  })

  it('does NOT pass another provider\'s providerContent verbatim (cross-provider replay)', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-5' })
    const spy = stubClient(adapter, 'chat.completions.create', {
      choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })

    const foreign: NeutralMessage = {
      role: 'assistant',
      content: 'visible text',
      toolCalls: [{ id: 'tc-7', name: 'post', input: { body: 'z' } }],
      // Bogus Anthropic-shaped blocks tagged as belonging to a DIFFERENT adapter.
      providerContent: [{ type: 'thinking', thinking: 'secret', signature: 'sig-xyz' }],
      providerAdapter: 'anthropic:claude-opus-4-8',
    }
    await adapter.turn({ system: 's', tools: [], messages: [foreign] })

    const body = spy.calls[0] as { messages: Array<{ role: string; content?: unknown }> }
    const wire = JSON.stringify(body.messages)
    // The foreign raw blocks must not survive into the OpenAI request...
    expect(wire).not.toContain('sig-xyz')
    expect(wire).not.toContain('thinking')
    // ...and the turn is reconstructed from text + toolCalls instead.
    const assistant = body.messages.find(m => m.role === 'assistant')
    expect(JSON.stringify(assistant)).toContain('visible text')
  })
})

describe('GeminiAdapter', () => {
  it('names itself gemini:<model> and carries its manifest', () => {
    const adapter = new GeminiAdapter({
      apiKey: 'test',
      model: 'gemini-2.5-pro',
      manifest: { provider: 'google', strengths: ['vision'], cautions: ['safety filters'], costClass: 'cheap' },
    })
    expect(adapter.name).toBe('gemini:gemini-2.5-pro')
    expect(adapter.manifest?.strengths).toContain('vision')
  })

  it('maps a TurnRequest to the generateContent wire shape', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'test', model: 'gemini-2.5-pro' })
    const canned = {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    }
    const spy = stubClient(adapter, 'models.generateContent', canned)

    await adapter.turn({
      system: 'be terse',
      tools: oneTool,
      messages: [
        { role: 'user', content: 'do the thing' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'tc-1', name: 'post', input: { body: 'x' } }],
          providerAdapter: 'gemini:gemini-2.5-pro',
        },
        { role: 'tool_results', results: [{ toolCallId: 'tc-1', content: 'ok' }] },
      ],
    })

    expect(spy.calls).toHaveLength(1)
    const body = spy.calls[0] as {
      model: string
      contents: Array<{ role: string; parts: unknown[] }>
      config?: { systemInstruction?: unknown; tools?: unknown }
    }
    expect(body.model).toBe('gemini-2.5-pro')
    // roles are user/model (not assistant)
    expect(body.contents.map(c => c.role)).toContain('user')
    expect(body.contents.map(c => c.role)).toContain('model')
    expect(body.contents.map(c => c.role)).not.toContain('assistant')
    // system prompt rides in config.systemInstruction
    expect(JSON.stringify(body.config?.systemInstruction)).toContain('be terse')
    // the assistant turn carries a functionCall part; tool_results a functionResponse
    const wire = JSON.stringify(body.contents)
    expect(wire).toContain('functionCall')
    expect(wire).toContain('functionResponse')
  })

  it('parses a canned response into a TurnResult (text, toolCalls, stopReason, usage)', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'test', model: 'gemini-2.5-pro' })
    const canned = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'sure thing' },
              { functionCall: { name: 'post', args: { body: 'hello' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 9 },
    }
    stubClient(adapter, 'models.generateContent', canned)

    const result = await adapter.turn(emptyRequest)
    expect(result.text).toBe('sure thing')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe('post')
    expect(result.toolCalls[0]?.input).toEqual({ body: 'hello' })
    expect(result.stopReason).toBe('complete')
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 9 })
  })

  it('maps a SAFETY finish to a refusal stopReason', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'test', model: 'gemini-2.5-pro' })
    stubClient(adapter, 'models.generateContent', {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
    })
    expect((await adapter.turn(emptyRequest)).stopReason).toBe('refusal')
  })

  it('does NOT pass another provider\'s providerContent verbatim (cross-provider replay)', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'test', model: 'gemini-2.5-pro' })
    const spy = stubClient(adapter, 'models.generateContent', {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    })

    const foreign: NeutralMessage = {
      role: 'assistant',
      content: 'visible text',
      toolCalls: [{ id: 'tc-7', name: 'post', input: { body: 'z' } }],
      providerContent: [{ type: 'thinking', thinking: 'secret', signature: 'sig-xyz' }],
      providerAdapter: 'anthropic:claude-opus-4-8',
    }
    await adapter.turn({ system: 's', tools: [], messages: [foreign] })

    const body = spy.calls[0] as { contents: unknown }
    const wire = JSON.stringify(body.contents)
    expect(wire).not.toContain('sig-xyz')
    expect(wire).not.toContain('thinking')
    // reconstructed from text + toolCalls
    expect(wire).toContain('visible text')
    expect(wire).toContain('functionCall')
  })
})
