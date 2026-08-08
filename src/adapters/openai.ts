import OpenAI from 'openai'
import type {
  ModelAdapter,
  ModelManifest,
  NeutralMessage,
  StopReason,
  ToolCall,
  ToolDef,
  TurnRequest,
  TurnResult,
} from './types.js'

export interface OpenAIAdapterOptions {
  /** Default 'gpt-5'. */
  model?: string
  /** Default: SDK env resolution (OPENAI_API_KEY etc.). */
  apiKey?: string
  /** Override the API base URL — how OpenRouter and other wire-compatible hosts plug in. */
  baseURL?: string
  /** Adapter name; defaults to 'openai:'+model. */
  name?: string
  manifest?: ModelManifest
}

const DEFAULT_MODEL = 'gpt-5'

/**
 * Exported for tests. Maps a neutral message onto one or more OpenAI chat
 * messages. Note a neutral tool_results message fans out into one {role:'tool'}
 * message per result, so this returns an array.
 *
 * providerContent is intentionally ignored here: even when the producing
 * adapter is this one, we always reconstruct from text + toolCalls. OpenAI's
 * wire shape has no load-bearing opaque blocks (unlike Anthropic thinking
 * signatures), so reconstruction is lossless and safe across a model switch.
 */
export function toOpenAIMessages(msg: NeutralMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
  switch (msg.role) {
    case 'user':
      return [{ role: 'user', content: msg.content }]
    case 'assistant': {
      const out: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg.content,
      }
      if (msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map(
          (call): OpenAI.Chat.ChatCompletionMessageFunctionToolCall => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          }),
        )
      }
      return [out]
    }
    case 'tool_results':
      return msg.results.map(
        (r): OpenAI.Chat.ChatCompletionToolMessageParam => ({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.content,
        }),
      )
  }
}

/** Exported for tests. Builds the full messages array, prepending the system prompt. */
export function toOpenAIRequestMessages(req: TurnRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }]
  for (const msg of req.messages) messages.push(...toOpenAIMessages(msg))
  return messages
}

/** Exported for tests. Maps neutral tool defs onto OpenAI function tools. */
export function toOpenAITools(tools: ToolDef[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(
    (t): OpenAI.Chat.ChatCompletionFunctionTool => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }),
  )
}

/** Exported for tests. Maps the provider finish_reason onto the neutral StopReason. */
export function toStopReason(finishReason: string | null | undefined): StopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'complete'
    default:
      return 'other'
  }
}

/** Exported for tests. Parses a chat completion response into a TurnResult. */
export function parseResponse(response: OpenAI.Chat.ChatCompletion): TurnResult {
  const choice = response.choices[0]
  const message = choice?.message
  const text = message?.content ?? ''
  const toolCalls: ToolCall[] = []
  for (const tc of message?.tool_calls ?? []) {
    if (tc.type !== 'function') continue
    let input: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(tc.function.arguments || '{}')
      if (parsed !== null && typeof parsed === 'object') input = parsed as Record<string, unknown>
    } catch {
      // Malformed arguments: keep the raw string so the failure is inspectable
      // rather than silently dropping the call.
      input = { _raw: tc.function.arguments }
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, input })
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    stopReason: toStopReason(choice?.finish_reason),
  }
}

export class OpenAIAdapter implements ModelAdapter {
  readonly name: string
  readonly manifest?: ModelManifest

  private readonly client: OpenAI
  protected readonly model: string

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    const clientOpts: { apiKey?: string; baseURL?: string } = {}
    if (opts.apiKey !== undefined) clientOpts.apiKey = opts.apiKey
    if (opts.baseURL !== undefined) clientOpts.baseURL = opts.baseURL
    this.client = new OpenAI(clientOpts)
    this.name = opts.name ?? `openai:${this.model}`
    this.manifest = opts.manifest ?? {
      provider: 'openai',
      strengths: ['general reasoning', 'code', 'structured/JSON output', 'tool use', 'broad knowledge'],
      cautions: ['moderation filters may block some security/exploit content', 'occasional over-refusal'],
      costClass: 'moderate',
    }
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIRequestMessages(req),
      tools: req.tools.length > 0 ? toOpenAITools(req.tools) : undefined,
    })
    return parseResponse(response)
  }
}

export interface OpenRouterAdapterOptions {
  /** Default 'anthropic/claude-3.5-sonnet'. */
  model?: string
  /** Default: opts.apiKey ?? process.env.OPENROUTER_API_KEY. */
  apiKey?: string
  /** Adapter name; defaults to 'openrouter:'+model. */
  name?: string
  manifest?: ModelManifest
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet'

/**
 * OpenRouter is OpenAI-wire-compatible, so it's just an OpenAIAdapter pointed at
 * OpenRouter's base URL with its own key and default model. The neutral→wire
 * mapping is inherited verbatim.
 */
export class OpenRouterAdapter extends OpenAIAdapter {
  constructor(opts: OpenRouterAdapterOptions = {}) {
    const model = opts.model ?? OPENROUTER_DEFAULT_MODEL
    super({
      model,
      apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      name: opts.name ?? `openrouter:${model}`,
      manifest: opts.manifest ?? {
        provider: 'openrouter',
        strengths: ['routes to many providers/models behind one wire format', 'model breadth'],
        cautions: [
          'behavior, guardrails, and cost vary by the underlying routed model',
          'check the specific model id you route to',
        ],
        costClass: 'moderate',
      },
    })
  }
}
