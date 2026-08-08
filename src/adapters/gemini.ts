import { GoogleGenAI } from '@google/genai'
import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
  Tool,
} from '@google/genai'
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

export interface GeminiAdapterOptions {
  /** Default 'gemini-2.5-pro'. */
  model?: string
  /** Default: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY. */
  apiKey?: string
  /** Adapter name; defaults to 'gemini:'+model. */
  name?: string
  manifest?: ModelManifest
}

const DEFAULT_MODEL = 'gemini-2.5-pro'

/**
 * Exported for tests. Maps a neutral message onto Gemini `Content`.
 *
 * providerContent is intentionally ignored — we always reconstruct from
 * text + toolCalls. Gemini roles are 'user' and 'model'; the assistant maps
 * to 'model' with functionCall parts, and tool_results map to a 'user'-role
 * message carrying functionResponse parts (Gemini's convention for feeding
 * tool output back). Gemini has no wire-level call id, so functionResponse is
 * keyed by tool name.
 */
export function toGeminiContent(msg: NeutralMessage, toolNameById: Map<string, string>): Content {
  switch (msg.role) {
    case 'user':
      return { role: 'user', parts: [{ text: msg.content }] }
    case 'assistant': {
      const parts: Part[] = []
      if (msg.content.trim() !== '') parts.push({ text: msg.content })
      for (const call of msg.toolCalls) {
        toolNameById.set(call.id, call.name)
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.input } })
      }
      // Gemini rejects an empty parts array; keep the turn with a placeholder.
      if (parts.length === 0) parts.push({ text: '(no output this turn)' })
      return { role: 'model', parts }
    }
    case 'tool_results':
      return {
        role: 'user',
        parts: msg.results.map((r): Part => {
          const name = toolNameById.get(r.toolCallId) ?? r.toolCallId
          return {
            functionResponse: {
              id: r.toolCallId,
              name,
              response: r.isError === true ? { error: r.content } : { output: r.content },
            },
          }
        }),
      }
  }
}

/** Exported for tests. Maps neutral messages onto the Gemini contents array. */
export function toGeminiContents(messages: NeutralMessage[]): Content[] {
  // Threaded through so tool_results can recover the tool name from the id the
  // preceding assistant turn used.
  const toolNameById = new Map<string, string>()
  return messages.map(m => toGeminiContent(m, toolNameById))
}

/** Exported for tests. Maps neutral tool defs onto a single Gemini Tool with functionDeclarations. */
export function toGeminiTools(tools: ToolDef[]): Tool[] {
  if (tools.length === 0) return []
  return [
    {
      functionDeclarations: tools.map(
        (t): FunctionDeclaration => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.inputSchema,
        }),
      ),
    },
  ]
}

/** Exported for tests. Maps the provider finishReason onto the neutral StopReason. */
export function toStopReason(finishReason: string | null | undefined): StopReason {
  switch (finishReason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'refusal'
    case 'STOP':
      return 'complete'
    case undefined:
    case null:
      // Missing finishReason on a well-formed candidate: treat as a normal stop.
      return 'complete'
    default:
      return 'other'
  }
}

/** Exported for tests. Parses a generateContent response into a TurnResult. */
export function parseResponse(response: GenerateContentResponse): TurnResult {
  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  let text = ''
  const toolCalls: ToolCall[] = []
  parts.forEach((part, index) => {
    if (typeof part.text === 'string') text += part.text
    const fc = part.functionCall
    if (fc !== undefined && typeof fc.name === 'string') {
      // Gemini may or may not supply an id; synthesize a stable one when absent
      // so downstream tool_result matching has something to key on.
      const id = fc.id ?? `g-${index}-${fc.name}`
      toolCalls.push({ id, name: fc.name, input: fc.args ?? {} })
    }
  })

  const usage = response.usageMetadata
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
    stopReason: toStopReason(candidate?.finishReason),
  }
}

export class GeminiAdapter implements ModelAdapter {
  readonly name: string
  readonly manifest?: ModelManifest

  private readonly client: GoogleGenAI
  private readonly model: string

  constructor(opts: GeminiAdapterOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    this.client = new GoogleGenAI({ apiKey })
    this.name = opts.name ?? `gemini:${this.model}`
    this.manifest = opts.manifest ?? {
      provider: 'google',
      strengths: [
        'strong vision / multimodal',
        'very long context',
        'long-document synthesis',
        'broad knowledge',
      ],
      cautions: [
        'distinct safety-filter profile — may block security/exploit or otherwise sensitive content differently than other providers',
        'no native tool-call ids (synthesized by this adapter)',
        'can be strict on structured-output edge cases',
      ],
      costClass: 'moderate',
    }
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const tools = toGeminiTools(req.tools)
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGeminiContents(req.messages),
      config: {
        systemInstruction: req.system,
        ...(tools.length > 0 ? { tools } : {}),
      },
    })
    return parseResponse(response)
  }
}
