/**
 * Provider-agnostic model interface. A swarm member is anything that can take
 * a system prompt, a message history, and a tool list, and return text plus
 * tool calls. Adapters map this neutral shape onto a concrete provider SDK.
 */

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export type NeutralMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls: ToolCall[]
      /**
       * Opaque provider-native content for lossless replay. The Anthropic
       * adapter stores the raw response blocks here (thinking blocks carry
       * signatures that must be echoed back verbatim on tool-use
       * continuations). Only meaningful to the adapter that produced it.
       */
      providerContent?: unknown
    }
  | { role: 'tool_results'; results: Array<{ toolCallId: string; content: string; isError?: boolean }> }

export interface TurnRequest {
  system: string
  messages: NeutralMessage[]
  tools: ToolDef[]
}

export type StopReason = 'complete' | 'max_tokens' | 'refusal' | 'other'

export interface TurnResult {
  text: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  /** See NeutralMessage.providerContent. */
  providerContent?: unknown
  /** Defaults to 'complete' when an adapter does not report it. */
  stopReason?: StopReason
}

export interface ModelAdapter {
  readonly name: string
  turn(req: TurnRequest): Promise<TurnResult>
}
