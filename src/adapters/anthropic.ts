import Anthropic from '@anthropic-ai/sdk'
import type { ModelAdapter, NeutralMessage, StopReason, ToolCall, TurnRequest, TurnResult } from './types.js'

export interface AnthropicAdapterOptions {
  /** Default 'claude-opus-4-8'. */
  model?: string
  /** Default: SDK env resolution (ANTHROPIC_API_KEY etc.). */
  apiKey?: string
  /** Default 16000. */
  maxTokens?: number
}

const DEFAULT_MODEL = 'claude-opus-4-8'
const DEFAULT_MAX_TOKENS = 16000

/** Exported for tests. Maps a neutral message onto the Anthropic wire shape. */
export function toAnthropicMessage(msg: NeutralMessage): Anthropic.MessageParam {
  switch (msg.role) {
    case 'user':
      return { role: 'user', content: msg.content }
    case 'assistant': {
      if (msg.providerContent !== undefined) {
        // Lossless replay: the raw response blocks include thinking /
        // redacted_thinking whose signatures are load-bearing and must be
        // echoed back verbatim on tool-use continuations.
        return { role: 'assistant', content: msg.providerContent as Anthropic.ContentBlockParam[] }
      }
      const content: Anthropic.ContentBlockParam[] = []
      if (msg.content.trim() !== '') {
        content.push({ type: 'text', text: msg.content })
      }
      for (const call of msg.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      if (content.length === 0) {
        // The API 400s on an assistant message with empty content; keep the
        // turn structure with a placeholder instead.
        content.push({ type: 'text', text: '(no output this turn)' })
      }
      return { role: 'assistant', content }
    }
    case 'tool_results':
      return {
        role: 'user',
        content: msg.results.map(
          (r): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: r.toolCallId,
            content: r.content,
            is_error: r.isError ?? false,
          }),
        ),
      }
  }
}

/** Exported for tests. Maps the provider stop_reason onto the neutral StopReason. */
export function toStopReason(stopReason: string | null): StopReason {
  switch (stopReason) {
    case 'end_turn':
    case 'tool_use':
    case 'stop_sequence':
      return 'complete'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

/** Exported for tests. Parses a Messages API response into a TurnResult. */
export function parseResponse(response: Anthropic.Message): TurnResult {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })
    }
    // thinking / redacted_thinking / server tool blocks carry no neutral text,
    // but are preserved verbatim in providerContent for lossless replay.
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    providerContent: response.content,
    stopReason: toStopReason(response.stop_reason),
  }
}

export class AnthropicAdapter implements ModelAdapter {
  /** Includes the model so mixed-tier swarms are tellable apart in snapshots. */
  readonly name: string

  private readonly client: Anthropic
  private readonly model: string
  private readonly maxTokens: number

  constructor(opts: AnthropicAdapterOptions = {}) {
    // Bare constructor lets the SDK resolve credentials from the environment.
    this.client = opts.apiKey !== undefined ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic()
    this.model = opts.model ?? DEFAULT_MODEL
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
    this.name = `anthropic:${this.model}`
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    // Adaptive thinking only; no temperature/top_p/top_k — they 400 on this model.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: 'adaptive' },
      system: req.system,
      tools: req.tools.map(
        (t): Anthropic.Tool => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }),
      ),
      messages: req.messages.map(toAnthropicMessage),
    })

    return parseResponse(response)
  }
}
