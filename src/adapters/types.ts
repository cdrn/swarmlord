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
       * continuations). Only meaningful to the adapter that produced it —
       * see `providerAdapter`.
       */
      providerContent?: unknown
      /**
       * Name of the adapter that produced `providerContent`. The runtime sets
       * this when recording a turn. An adapter MUST ignore providerContent
       * whose tag isn't its own name and fall back to reconstructing the turn
       * from text + toolCalls — otherwise replaying (e.g.) Anthropic thinking
       * blocks through OpenAI would be malformed. This is what makes an
       * agent's history safe to carry across a model switch.
       */
      providerAdapter?: string
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

/**
 * Self-description a model publishes to the swarm so agents can choose it well.
 * Written for the model that reads it, in the same spirit as a channel's
 * purpose — `cautions` is where "strict guardrails, will refuse exploit
 * analysis" or "weak at strict JSON" lives, in words a spawner can reason over.
 */
export interface ModelManifest {
  provider: string
  /** What this model is good at, e.g. 'code', 'long-horizon synthesis', 'vision'. */
  strengths: string[]
  /** Where it's weak or restricted — proficiency gaps and guardrail edges. */
  cautions: string[]
  costClass: 'cheap' | 'moderate' | 'expensive'
}

export interface ModelAdapter {
  readonly name: string
  /** Optional self-description surfaced in the model catalog. */
  readonly manifest?: ModelManifest
  turn(req: TurnRequest): Promise<TurnResult>
}
