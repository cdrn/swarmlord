import type { ModelAdapter, ModelManifest, TurnRequest, TurnResult } from './types.js'

export type MockHandler = (req: TurnRequest, callIndex: number) => TurnResult

export interface MockAdapterOptions {
  /** Override the adapter name (default 'mock') — useful for multi-adapter tests. */
  name?: string
  /** Optional self-description, so a mock can stand in for a catalogued model. */
  manifest?: ModelManifest
}

/** Scripted adapter for tests and offline demos. */
export class MockAdapter implements ModelAdapter {
  readonly name: string
  readonly manifest?: ModelManifest

  private callIndex = 0

  constructor(
    private readonly handler: MockHandler,
    opts: MockAdapterOptions = {},
  ) {
    this.name = opts.name ?? 'mock'
    this.manifest = opts.manifest
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const result = this.handler(req, this.callIndex++)
    // Default stopReason so the runtime never sees an undefined stop condition.
    return result.stopReason === undefined ? { ...result, stopReason: 'complete' } : result
  }
}

/** Builds a TurnResult with fabricated tool-call ids (`tc-1`, `tc-2`, ...). */
export function turnOf(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
  text = '',
): TurnResult {
  return {
    text,
    toolCalls: toolCalls.map((tc, i) => ({ id: `tc-${i + 1}`, name: tc.name, input: tc.input })),
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}
