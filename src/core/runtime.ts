/**
 * The Swarm runtime: round-robin scheduling over ready agents, one adapter
 * turn each, sequential tool execution, and subscription-driven wakes. All
 * coordination state lives on the log/board; the runtime only holds each
 * agent's message history and wake queue.
 */

import { EventLog } from './log.js'
import { Blackboard } from './board.js'
import { matchesFilter, type SubscriptionFilter } from './subscriptions.js'
import type { EventType, SwarmEvent } from './events.js'
import type { ModelAdapter, NeutralMessage, ToolCall, TurnResult } from '../adapters/types.js'
import { executeVerb, toolDefs, type VerbContext } from './verbs.js'

export interface AgentSpec {
  name: string
  role: string
  prompt: string
  subscriptions?: SubscriptionFilter[]
  /**
   * Per-agent adapter override — e.g. a cheaper model for scouts while the
   * overseer runs the big one. Only settable from code (specs passed to
   * spawn()/run()); the spawn verb can't reach it.
   */
  adapter?: ModelAdapter
}

export interface SwarmOptions {
  adapter: ModelAdapter
  dbPath?: string
  maxAgents?: number
  maxTotalTurns?: number
  pinSlots?: number
  claimTtlMs?: number
  /**
   * Defaults for the root agent spawned by run() — set the overseer prompt,
   * name, role, subscriptions, or adapter here. run()'s own root argument
   * overrides these field by field.
   */
  root?: Partial<AgentSpec>
  /**
   * Replace the built-in protocol preamble (the shared system-prompt rules
   * every agent gets). Start from the exported PROTOCOL_PREAMBLE to tweak
   * rather than rewrite.
   */
  protocolPreamble?: string
  /** Appended after the (built-in or replaced) preamble — house rules. */
  protocolAppendix?: string
  onEvent?: (evt: SwarmEvent) => void
  onTurn?: (info: { agent: string; turn: number; text: string; toolCalls: ToolCall[] }) => void
}

export interface SwarmResult {
  turns: number
  agents: string[]
  finalSummaries: Record<string, string>
  events: number
}

export type AgentStatus = 'ready' | 'idle' | 'done'

/** Point-in-time view of one agent, for UIs and monitoring. */
export interface AgentSnapshot {
  name: string
  role: string
  status: AgentStatus
  parent: string | null
  turns: number
  pendingWakes: number
  lastActivity: string
  lastActivityAt: number
  summary: string | null
  /** Name of the adapter this agent runs on (per-agent override or swarm default). */
  adapter: string
}

export interface SwarmSnapshot {
  agents: AgentSnapshot[]
  turnsTaken: number
  maxTotalTurns: number
  maxAgents: number
  lastEventId: number
}

interface AgentState {
  spec: AgentSpec
  status: AgentStatus
  parent: string | null
  turns: number
  lastActivity: string
  lastActivityAt: number
  summary: string | null
  messages: NeutralMessage[]
  subscriptions: SubscriptionFilter[]
  wakes: SwarmEvent[]
}

export const PROTOCOL_PREAMBLE = `You are one agent in a swarm coordinating through a shared event log and blackboard. Everything anyone does is an event with an id; channels, claims, and pins are views over that log. Follow this protocol:

1. Orient before you act. Use list_channels and query to see what already exists. The channel or finding you need probably already exists — read it before creating or re-deriving it.
2. Cite, don't copy. Event ids are citations. When you build on prior work, pass those ids in refs instead of restating the content.
3. Claim before working. Before working a task event, claim it. If someone already holds it you'll be told who — read their work, then either pick different work or join consciously with join:true. Release claims you abandon.
4. Post findings once, in the best-fitting channel, then reference them by id everywhere else. Exact duplicates get linked, not blocked — independent convergence is signal, but unknowing duplication is waste.
5. Create channels sparingly. create_channel searches for near-matches first; prefer an existing channel over forcing a new one. Merge channels that have converged.
6. Pin only what everyone must see. Pin slots are scarce on purpose.
7. Spawn agents for parallelizable work. Give each a clear name, role, and prompt saying what to do, where to post, and to call complete when finished. Spawns are public events.
8. Subscribe to what you must react to, then idle when you're waiting on others. You wake only on subscribed events — subscribe before you idle.
9. Call complete with a summary (citing event ids) when your work is truly finished. Idle means waiting; complete means done for good.`

export const DEFAULT_ROOT_PROMPT = `You are the coordinator of this swarm. Break the task into independent workstreams and spawn a focused agent for each rather than doing everything yourself. Set up channels for the work (checking the catalog first), tell each spawned agent where to post, and subscribe to their channels and to agent_done events so their results wake you. While workers run, idle; when woken, read what arrived, integrate, redirect or spawn as needed. When the task is fulfilled, post a final synthesis citing the key event ids, then call complete with a summary.`

const DEFAULT_MAX_AGENTS = 32
const DEFAULT_MAX_TOTAL_TURNS = 200

/**
 * Bookkeeping event types wake an agent only when its filter EXPLICITLY lists
 * the type in `types` — never via catch-all/tag/text matches. Otherwise two
 * broadly-subscribed agents livelock waking each other with agent_idle events.
 */
const BOOKKEEPING_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'agent_idle',
  'agent_done',
  'claimed',
  'claim_released',
  'spawned',
])

/** Pins are the salience mechanism: pin/unpin events cut through subscriptions. */
const SALIENCE_TYPES: ReadonlySet<EventType> = new Set<EventType>(['pinned', 'unpinned'])

export class Swarm {
  readonly log: EventLog
  readonly board: Blackboard

  private readonly adapter: ModelAdapter
  private readonly maxAgents: number
  private readonly maxTotalTurns: number
  private readonly protocol: string
  private readonly rootDefaults: Partial<AgentSpec>
  private readonly onEvent?: (evt: SwarmEvent) => void
  private readonly onTurn?: SwarmOptions['onTurn']

  private readonly agents = new Map<string, AgentState>()
  private turnsTaken = 0
  /** Cursor for onEvent delivery: every event with id > this has been reported. */
  private notifiedUpTo: number

  constructor(opts: SwarmOptions) {
    this.adapter = opts.adapter
    this.maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS
    this.maxTotalTurns = opts.maxTotalTurns ?? DEFAULT_MAX_TOTAL_TURNS
    this.protocol =
      (opts.protocolPreamble ?? PROTOCOL_PREAMBLE) +
      (opts.protocolAppendix ? `\n\n${opts.protocolAppendix}` : '')
    this.rootDefaults = opts.root ?? {}
    this.onEvent = opts.onEvent
    this.onTurn = opts.onTurn
    this.log = new EventLog(opts.dbPath)
    // A pre-existing dbPath must never replay as wakes/onEvent: only events
    // appended during this process count as "new".
    this.notifiedUpTo = this.log.lastId()
    this.board = new Blackboard(this.log, {
      pinSlots: opts.pinSlots,
      claimTtlMs: opts.claimTtlMs,
    })
  }

  /** Point-in-time view of the swarm, for UIs and monitoring. */
  snapshot(): SwarmSnapshot {
    return {
      agents: [...this.agents.values()].map(s => ({
        name: s.spec.name,
        role: s.spec.role,
        status: s.status,
        parent: s.parent,
        turns: s.turns,
        pendingWakes: s.wakes.length,
        lastActivity: s.lastActivity,
        lastActivityAt: s.lastActivityAt,
        summary: s.summary,
        adapter: (s.spec.adapter ?? this.adapter).name,
      })),
      turnsTaken: this.turnsTaken,
      maxTotalTurns: this.maxTotalTurns,
      maxAgents: this.maxAgents,
      lastEventId: this.log.lastId(),
    }
  }

  private setActivity(state: AgentState, activity: string): void {
    state.lastActivity = activity
    state.lastActivityAt = Date.now()
  }

  spawn(parent: string | null, spec: AgentSpec): { ok: boolean; error?: string } {
    const result = this.spawnInternal(parent, spec, spec.prompt)
    this.deliverNewEvents(null)
    return result
  }

  private spawnInternal(
    parent: string | null,
    spec: AgentSpec,
    firstMessage: string,
  ): { ok: boolean; error?: string } {
    if (this.agents.size >= this.maxAgents) {
      return { ok: false, error: `max agents (${this.maxAgents}) reached` }
    }
    if (this.agents.has(spec.name)) {
      return { ok: false, error: `agent "${spec.name}" already exists` }
    }

    this.agents.set(spec.name, {
      spec,
      status: 'ready',
      parent,
      turns: 0,
      lastActivity: 'spawned',
      lastActivityAt: Date.now(),
      summary: null,
      messages: [{ role: 'user', content: firstMessage }],
      subscriptions: [...(spec.subscriptions ?? [])],
      wakes: [],
    })

    const promptSummary = spec.prompt.length > 300 ? spec.prompt.slice(0, 300) + '…' : spec.prompt
    this.log.append({
      type: 'spawned',
      agent: spec.name,
      channel: null,
      body: `${spec.role}: ${promptSummary}`,
      tags: [],
      refs: [],
      meta: { parent },
    })
    return { ok: true }
  }

  async run(task: string, root?: Partial<AgentSpec>): Promise<SwarmResult> {
    const rootSpec: AgentSpec = {
      name: root?.name ?? this.rootDefaults.name ?? 'overseer',
      role: root?.role ?? this.rootDefaults.role ?? 'coordinator',
      prompt: root?.prompt ?? this.rootDefaults.prompt ?? DEFAULT_ROOT_PROMPT,
      subscriptions: root?.subscriptions ?? this.rootDefaults.subscriptions,
      adapter: root?.adapter ?? this.rootDefaults.adapter,
    }
    const spawned = this.spawnInternal(null, rootSpec, task)
    if (!spawned.ok) throw new Error(`failed to spawn root agent: ${spawned.error}`)
    this.deliverNewEvents(null)

    const finalSummaries: Record<string, string> = {}

    outer: while (this.turnsTaken < this.maxTotalTurns) {
      // Idle agents with queued wakes become ready again.
      for (const state of this.agents.values()) {
        if (state.status === 'idle' && state.wakes.length > 0) state.status = 'ready'
      }
      const ready = [...this.agents.values()].filter(s => s.status === 'ready')
      if (ready.length === 0) break

      for (const state of ready) {
        if (this.turnsTaken >= this.maxTotalTurns) break outer
        if (state.status !== 'ready') continue
        const summary = await this.takeTurn(state)
        if (summary !== null) finalSummaries[state.spec.name] = summary
      }
    }

    return {
      turns: this.turnsTaken,
      agents: [...this.agents.keys()],
      finalSummaries,
      events: this.log.lastId(),
    }
  }

  /** Runs one adapter turn for the agent. Returns the `complete` summary if it finished. */
  private async takeTurn(state: AgentState): Promise<string | null> {
    const name = state.spec.name

    if (state.wakes.length > 0) {
      state.messages.push({ role: 'user', content: formatWakes(state.wakes) })
      state.wakes = []
    }

    this.setActivity(state, 'thinking…')
    let result: TurnResult
    try {
      result = await (state.spec.adapter ?? this.adapter).turn({
        system: this.buildSystemPrompt(state.spec),
        messages: state.messages,
        tools: toolDefs,
      })
    } catch (e) {
      // One agent's API failure must not kill the swarm: record it, retire
      // the agent, and let the run continue.
      const message = e instanceof Error ? e.message : String(e)
      state.status = 'done'
      state.summary = `adapter error: ${message}`
      this.setActivity(state, `adapter error: ${message}`)
      this.log.append({
        type: 'system',
        agent: name,
        channel: null,
        body: `adapter error: ${message}`,
        tags: [],
        refs: [],
        meta: { error: message },
      })
      this.deliverNewEvents(name)
      return `adapter error: ${message}`
    }
    this.turnsTaken++
    state.turns++
    this.onTurn?.({
      agent: name,
      turn: this.turnsTaken,
      text: result.text,
      toolCalls: result.toolCalls,
    })

    const stopReason = result.stopReason ?? 'complete'

    if (stopReason === 'max_tokens' || stopReason === 'other') {
      // Truncated (or unrecognized) stop: trailing tool calls may be mangled,
      // so none of them execute. Record the turn without toolCalls or
      // providerContent so replayed history never contains dangling tool_use
      // blocks, tell the agent, and let it retry — it stays ready.
      state.messages.push({ role: 'assistant', content: result.text, toolCalls: [] })
      this.log.append({
        type: 'system',
        agent: name,
        channel: null,
        body: `turn truncated (stop reason: ${stopReason}); ${result.toolCalls.length} tool call(s) discarded`,
        tags: [],
        refs: [],
        meta: { stopReason, discardedToolCalls: result.toolCalls.length },
      })
      state.messages.push({
        role: 'user',
        content:
          `(Your previous turn was cut off before it completed (stop reason: ${stopReason}). ` +
          'None of its tool calls were executed. Re-issue the work, splitting it into ' +
          'smaller steps if needed.)',
      })
      this.deliverNewEvents(name)
      return null
    }

    if (stopReason === 'refusal') {
      state.messages.push({ role: 'assistant', content: result.text, toolCalls: [] })
      state.status = 'idle'
      this.log.append({
        type: 'agent_idle',
        agent: name,
        channel: null,
        body: 'auto-idled: model refused to continue the turn',
        tags: [],
        refs: [],
        meta: { stopReason },
      })
      state.messages.push({
        role: 'user',
        content:
          '(Your turn ended in a refusal, so you were idled. You will wake when an event ' +
          'matching your subscriptions arrives.)',
      })
      this.deliverNewEvents(name)
      return null
    }

    state.messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      providerContent: result.providerContent,
    })

    let summary: string | null = null

    if (result.toolCalls.length === 0) {
      state.status = 'idle'
      this.setActivity(state, 'idle — waiting on subscriptions')
      this.log.append({
        type: 'agent_idle',
        agent: name,
        channel: null,
        body: 'auto-idled: turn ended with no tool calls',
        tags: [],
        refs: [],
        meta: {},
      })
      state.messages.push({
        role: 'user',
        content:
          state.subscriptions.length > 0
            ? '(You made no tool calls, so you were idled. You will wake when an event ' +
              'matching your subscriptions arrives. Prefer calling idle or complete explicitly.)'
            : '(You made no tool calls, so you were idled — and you have NO subscriptions, ' +
              'so only a pin can wake you. If you are waiting on something, wake and ' +
              'subscribe to it; if you are finished, call complete.)',
      })
    } else {
      this.setActivity(state, describeToolCalls(result.toolCalls))
      const ctx: VerbContext = {
        board: this.board,
        log: this.log,
        // spawnInternal, not spawn: wake fan-out for the spawned event happens
        // once, at end of turn, with the acting-agent exclusion applied.
        spawn: (parent, spec) => this.spawnInternal(parent, spec, spec.prompt),
        addSubscription: (agentName, filter) => {
          this.agents.get(agentName)?.subscriptions.push(filter)
        },
        agentNames: () => [...this.agents.keys()],
        subscriptionsOf: agentName => this.agents.get(agentName)?.subscriptions ?? [],
      }
      const results: Array<{ toolCallId: string; content: string; isError?: boolean }> = []
      for (const call of result.toolCalls) {
        const verbResult = executeVerb(ctx, name, call)
        results.push({
          toolCallId: call.id,
          content: verbResult.content,
          isError: verbResult.isError,
        })
        if (verbResult.statusChange === 'idle' && state.status === 'ready') {
          state.status = 'idle'
          this.setActivity(state, 'idle — waiting on subscriptions')
        }
        if (verbResult.statusChange === 'done') {
          state.status = 'done'
          summary = verbResult.summary ?? ''
          state.summary = summary
          this.setActivity(state, 'complete')
        }
      }
      state.messages.push({ role: 'tool_results', results })
    }

    this.deliverNewEvents(name)
    return summary
  }

  /**
   * Fan events past the cursor out to subscriptions as wakes, and fire
   * onEvent. The acting agent is never woken by its own turn's events, and no
   * agent is woken by an event it authored (e.g. its own `spawned` event).
   */
  private deliverNewEvents(actingAgent: string | null): void {
    const lastId = this.log.lastId()
    if (lastId <= this.notifiedUpTo) return

    const events = this.log.query({
      sinceId: this.notifiedUpTo,
      limit: lastId - this.notifiedUpTo,
    })
    this.notifiedUpTo = lastId

    // Alias/case resolution, cached per batch to avoid repeated DB lookups.
    const resolved = new Map<string, string | null>()
    const resolve = (channelName: string): string | null => {
      const key = channelName.toLowerCase()
      let canonical = resolved.get(key)
      if (canonical === undefined) {
        canonical = this.board.resolve(channelName)
        resolved.set(key, canonical)
      }
      return canonical
    }

    for (const evt of events) {
      this.onEvent?.(evt)
      for (const [name, state] of this.agents) {
        if (state.status === 'done') continue
        if (name === actingAgent || name === evt.agent) continue
        if (this.wantsEvent(state, evt, resolve)) {
          state.wakes.push(evt)
        }
      }
    }
  }

  private wantsEvent(
    state: AgentState,
    evt: SwarmEvent,
    resolve: (name: string) => string | null,
  ): boolean {
    // Salience cut-through: pins reach everyone regardless of subscriptions.
    if (SALIENCE_TYPES.has(evt.type)) return true
    // Bookkeeping events are opt-in: only a filter explicitly listing the
    // type can match, so broad subscriptions never wake on idle chatter.
    if (BOOKKEEPING_TYPES.has(evt.type)) {
      return state.subscriptions.some(
        f => f.types?.includes(evt.type) === true && matchesFilter(f, evt, resolve),
      )
    }
    return state.subscriptions.some(f => matchesFilter(f, evt, resolve))
  }

  private buildSystemPrompt(spec: AgentSpec): string {
    let prompt =
      this.protocol +
      `\n\nYour name is "${spec.name}". Your role: ${spec.role}.\n\n` +
      spec.prompt
    const pins = this.board.pins()
    if (pins.length > 0) {
      const lines = pins.map(({ eventId, agent }) => {
        const evt = this.log.get(eventId)
        if (evt === null) return `#${eventId} (pinned by ${agent})`
        const body = evt.body.replace(/\s+/g, ' ').trim()
        const excerpt = body.length > 200 ? body.slice(0, 200) + '…' : body
        const where = evt.channel ? ` in #${evt.channel}` : ''
        return `#${evt.id} (pinned by ${agent})${where}: ${excerpt}`
      })
      prompt += `\n\nCurrently pinned (high-salience for the whole swarm):\n${lines.join('\n')}`
    }
    return prompt
  }
}

function describeToolCalls(calls: ToolCall[]): string {
  return calls
    .map(call => {
      const input = call.input as Record<string, unknown>
      const target =
        typeof input.channel === 'string' ? ` → #${input.channel}`
        : typeof input.name === 'string' ? ` → ${input.name}`
        : typeof input.event_id === 'number' ? ` → #${input.event_id}`
        : typeof input.text === 'string' ? ` "${input.text.slice(0, 30)}"`
        : ''
      return `${call.name}${target}`
    })
    .join(', ')
}

function formatWakes(wakes: SwarmEvent[]): string {
  const lines = wakes.map(evt => {
    const body = evt.body.replace(/\s+/g, ' ').trim()
    const excerpt = body.length > 200 ? body.slice(0, 200) + '…' : body
    const where = evt.channel ? ` in #${evt.channel}` : ''
    return `#${evt.id} [${evt.type}] by ${evt.agent}${where}: ${excerpt}`
  })
  return `New events matching your subscriptions:\n${lines.join('\n')}\n\nUse query with since_id or the refs above for full details.`
}
