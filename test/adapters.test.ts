import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { parseResponse, toAnthropicMessage, toStopReason } from '../src/adapters/anthropic.js'
import { MockAdapter, turnOf } from '../src/adapters/mock.js'
import type { NeutralMessage, StopReason, TurnRequest } from '../src/adapters/types.js'

const emptyRequest: TurnRequest = { system: 'sys', messages: [], tools: [] }

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
    const mapped = toAnthropicMessage({
      role: 'assistant',
      content: 'visible',
      toolCalls: [{ id: 'tc-9', name: 'idle', input: {} }],
      providerContent: sentinel,
    })
    expect(mapped.role).toBe('assistant')
    // Same array object — signatures on thinking blocks are load-bearing.
    expect(mapped.content).toBe(sentinel)
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
