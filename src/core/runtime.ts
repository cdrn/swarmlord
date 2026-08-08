/**
 * The Swarm runtime: round-robin scheduling over ready agents, one adapter
 * turn each, sequential tool execution, and subscription-driven wakes. All
 * coordination state lives on the log/board; the runtime only holds each
 * agent's message history and wake queue.
 */

import { EventLog } from './log.js'
import { Blackboard } from './board.js'
import { generateAgentName } from './names.js'
import { matchesFilter, type SubscriptionFilter } from './subscriptions.js'
import type { EventType, SwarmEvent } from './events.js'
import type { ModelAdapter, NeutralMessage, ToolCall, TurnResult } from '../adapters/types.js'
import { executeVerb, toolDefs, type VerbContext } from './verbs.js'

/**
 * Agent castes by model expense/proficiency. Map them to adapters via
 * SwarmOptions.tiers; spawning agents pick a tier per spawn (the verb teaches
 * when), or omit it and let SwarmOptions.tierWeights decide.
 */
export type TierName = 'heavy' | 'standard' | 'light'

export const TIER_NAMES: readonly TierName[] = ['heavy', 'standard', 'light']

export interface AgentSpec {
  name: string
  role: string
  prompt: string
  subscriptions?: SubscriptionFilter[]
  /**
   * Per-agent adapter override — e.g. a cheaper model for scouts while the
   * overseer runs the big one. Only settable from code (specs passed to
   * spawn()/run()); the spawn verb can't reach it. Wins over `model`/`tier`.
   */
  adapter?: ModelAdapter
  /** Pooled model name (from the catalog). The spawn verb can set this; wins over `tier`. */
  model?: string
  /** Named tier from SwarmOptions.tiers. The spawn verb can set this. */
  tier?: TierName
}

export interface ModelCatalogEntry {
  name: string
  provider: string
  strengths: string[]
  cautions: string[]
  costClass: 'cheap' | 'moderate' | 'expensive' | null
  retired: boolean
  isDefault: boolean
  /** Tier names currently pointing at this model. */
  tiers: TierName[]
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
   * Named model tiers. Spawns that name a tier get its adapter; spawns that
   * don't are sampled from tierWeights (falling back to the swarm default
   * adapter when no weights are set).
   */
  tiers?: Partial<Record<TierName, ModelAdapter>>
  /**
   * Relative weights for sampling a tier when a spawn names none, e.g.
   * { heavy: 1, standard: 3, light: 6 }. Only configured tiers count.
   */
  tierWeights?: Partial<Record<TierName, number>>
  /**
   * Extra adapters beyond the default and tier ones, made assignable to
   * tiers at runtime via configure() / the viewer's settings drawer.
   */
  adapters?: ModelAdapter[]
  /** Milliseconds to wait before each turn — throttle a swarm to watch it. */
  turnDelayMs?: number
  /**
   * When true, hitting maxTotalTurns pauses the run at the cap instead of
   * ending it, so raising the cap (slider/configure) resumes the same run.
   * The run then ends only on genuine quiescence or an explicit stop().
   * Default false: the cap is a hard stop (safe for headless scripts).
   */
  holdAtCap?: boolean
  /**
   * When true, agent-initiated spawns always get generated hive names
   * (vexeth, skarnix, ...) regardless of the name the spawner asked for.
   * Roles still describe what an agent does; names are just identity.
   */
  hiveNames?: boolean
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
  /** The tier this agent was spawned into, if tiers are configured. */
  tier: TierName | null
}

export interface SwarmConfigView {
  adapter: string
  /** null = unlimited (JSON can't carry Infinity). */
  maxAgents: number | null
  maxTotalTurns: number | null
  turnsTaken: number
  pinSlots: number
  claimTtlMs: number
  rootName: string
  rootPrompt: string
  protocol: string
  protocolAppendix: string
  paused: boolean
  turnDelayMs: number
  holdAtCap: boolean
  running: boolean
  hiveNames: boolean
  /** Configured tier name → adapter name. */
  tiers: Partial<Record<TierName, string>>
  tierWeights: Partial<Record<TierName, number>>
  /** Names of every adapter in the pool — assignable to tiers via configure(). */
  availableAdapters: string[]
  /** The full model catalog with manifests and retired flags. */
  models: ModelCatalogEntry[]
}

export interface SwarmConfigUpdate {
  /** null lifts the cap entirely. */
  maxAgents?: number | null
  maxTotalTurns?: number | null
  /** Reassign tiers to pooled adapters by name; null clears a tier. */
  tiers?: Partial<Record<TierName, string | null>>
  /** Replaces the whole weight set. */
  tierWeights?: Partial<Record<TierName, number>>
  pinSlots?: number
  claimTtlMs?: number
  /** Freeze/resume turn-taking. A paused swarm never terminates. */
  paused?: boolean
  turnDelayMs?: number
  /** Replaces the appendix; applies to every subsequent turn's system prompt. */
  protocolAppendix?: string
  /** Toggle forced hive names for agent-initiated spawns. */
  hiveNames?: boolean
  /** Toggle hold-at-cap behavior live. */
  holdAtCap?: boolean
  /** Set true to end the run for good (the explicit terminate). */
  stop?: boolean
  /** Model names to retire (unspawnable; running agents keep going). */
  retire?: string[]
  /** Model names to restore (spawnable again). */
  restore?: string[]
}

export interface SwarmSnapshot {
  agents: AgentSnapshot[]
  turnsTaken: number
  /** null = unlimited. */
  maxTotalTurns: number | null
  maxAgents: number | null
  lastEventId: number
}

interface AgentState {
  spec: AgentSpec
  status: AgentStatus
  parent: string | null
  /** Resolved at spawn: spec.adapter > tiers[spec.tier] > sampled/default. */
  adapter: ModelAdapter
  tier: TierName | null
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
8. Match the model to the work when you spawn. call list_models to see what's available — each model lists strengths, cautions, and cost. Pass model:<name> for a specific one, or tier (heavy/standard/light) for a coarse pick; omit both to accept the default. Read the cautions: some models have strict guardrails or weak spots, so don't hand a model a task its manifest warns against. Cheap models for scanning and bulk, capable models for synthesis and judgment.
9. Subscribe to what you must react to, then idle when you're waiting on others. You wake only on subscribed events — subscribe before you idle.
10. Call complete with a summary (citing event ids) when your work is truly finished. Idle means waiting; complete means done for good.`

export const DEFAULT_ROOT_PROMPT = `You are the coordinator of this swarm. Break the task into independent workstreams and spawn a focused agent for each rather than doing everything yourself. Consult list_models and choose a fitting model per worker — capable models for synthesis and judgment, cheap ones for scanning and bulk, and steer clear of a model whose cautions warn against the task. Set up channels for the work (checking the catalog first), tell each spawned agent where to post, and subscribe to their channels and to agent_done events so their results wake you.

Watch for models that are a bad fit: if a worker's model refuses its task (a refusal event) or flounders, that's a signal the pick was wrong — respawn the task on a model whose manifest fits, and if a model is consistently wrong for this swarm's work, retire_model it so nothing else spawns on it. Don't reflexively retry a refusal on another model just to get past it: judge whether it was a capability gap (reroute) or a correct refusal (respect it).

While workers run, idle; when woken, read what arrived, integrate, redirect or spawn as needed. When the task is fulfilled, post a final synthesis citing the key event ids, then call complete with a summary.`

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
  private maxAgents: number
  private maxTotalTurns: number
  private protocolBase: string
  private protocolAppendix: string
  private turnDelayMs: number
  private paused = false
  private running = false
  private stopped = false
  private holdAtCap: boolean
  private hiveNames: boolean
  private readonly rootDefaults: Partial<AgentSpec>
  private tiers: Partial<Record<TierName, ModelAdapter>>
  private tierWeights: Partial<Record<TierName, number>>
  /** Every adapter this swarm knows, by name — the pool tiers can draw from. */
  private readonly adapterPool = new Map<string, ModelAdapter>()
  /** Retired models: kept in the pool (existing agents run on) but unspawnable. */
  private readonly retired = new Set<string>()
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
    this.protocolBase = opts.protocolPreamble ?? PROTOCOL_PREAMBLE
    this.protocolAppendix = opts.protocolAppendix ?? ''
    this.turnDelayMs = opts.turnDelayMs ?? 0
    this.holdAtCap = opts.holdAtCap ?? false
    this.hiveNames = opts.hiveNames ?? false
    this.rootDefaults = opts.root ?? {}
    this.tiers = { ...opts.tiers }
    this.tierWeights = opts.tierWeights ?? {}
    this.adapterPool.set(opts.adapter.name, opts.adapter)
    for (const t of TIER_NAMES) {
      const a = this.tiers[t]
      if (a !== undefined) this.adapterPool.set(a.name, a)
    }
    for (const a of opts.adapters ?? []) this.adapterPool.set(a.name, a)
    if (this.rootDefaults.adapter) {
      this.adapterPool.set(this.rootDefaults.adapter.name, this.rootDefaults.adapter)
    }
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

  /** The swarm's effective configuration, for display and inspection. */
  config(): SwarmConfigView {
    return {
      adapter: this.adapter.name,
      maxAgents: Number.isFinite(this.maxAgents) ? this.maxAgents : null,
      maxTotalTurns: Number.isFinite(this.maxTotalTurns) ? this.maxTotalTurns : null,
      turnsTaken: this.turnsTaken,
      pinSlots: this.board.pinSlots,
      claimTtlMs: this.board.claimTtlMs,
      rootName: this.rootDefaults.name ?? 'overseer',
      rootPrompt: this.rootDefaults.prompt ?? DEFAULT_ROOT_PROMPT,
      protocol: this.protocol(),
      protocolAppendix: this.protocolAppendix,
      paused: this.paused,
      turnDelayMs: this.turnDelayMs,
      holdAtCap: this.holdAtCap,
      running: this.running,
      hiveNames: this.hiveNames,
      tiers: Object.fromEntries(
        TIER_NAMES.filter(t => this.tiers[t] !== undefined).map(t => [t, this.tiers[t]!.name]),
      ),
      tierWeights: { ...this.tierWeights },
      availableAdapters: [...this.adapterPool.keys()],
      models: this.catalog(),
    }
  }

  /**
   * Adjust the run backstops mid-flight. Raising maxTotalTurns extends a
   * running swarm; setting it at or below turnsTaken halts the run at the
   * next loop check — a usable soft-stop.
   */
  configure(update: SwarmConfigUpdate): SwarmConfigView {
    if (update.maxAgents !== undefined) {
      if (update.maxAgents === null) {
        this.maxAgents = Infinity
      } else if (!Number.isInteger(update.maxAgents) || update.maxAgents < 1) {
        throw new Error(`maxAgents must be a positive integer or null (unlimited), got ${update.maxAgents}`)
      } else {
        this.maxAgents = update.maxAgents
      }
    }
    if (update.maxTotalTurns !== undefined) {
      if (update.maxTotalTurns === null) {
        this.maxTotalTurns = Infinity
      } else if (!Number.isInteger(update.maxTotalTurns) || update.maxTotalTurns < 0) {
        throw new Error(
          `maxTotalTurns must be a non-negative integer or null (unlimited), got ${update.maxTotalTurns}`,
        )
      } else {
        this.maxTotalTurns = update.maxTotalTurns
      }
    }
    if (update.tiers !== undefined) {
      // Validate the whole batch before applying any of it.
      const staged: Array<[TierName, ModelAdapter | undefined]> = []
      for (const t of TIER_NAMES) {
        const name = update.tiers[t]
        if (name === undefined) continue
        if (name === null) {
          staged.push([t, undefined])
        } else {
          const adapter = this.adapterPool.get(name)
          if (adapter === undefined) {
            throw new Error(
              `unknown adapter "${name}" — available: ${[...this.adapterPool.keys()].join(', ')}`,
            )
          }
          staged.push([t, adapter])
        }
      }
      for (const [t, adapter] of staged) {
        if (adapter === undefined) delete this.tiers[t]
        else this.tiers[t] = adapter
      }
    }
    if (update.tierWeights !== undefined) {
      for (const t of TIER_NAMES) {
        const w = update.tierWeights[t]
        if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w < 0)) {
          throw new Error(`tier weight for "${t}" must be a non-negative number, got ${w}`)
        }
      }
      this.tierWeights = { ...update.tierWeights }
    }
    if (update.pinSlots !== undefined) {
      if (!Number.isInteger(update.pinSlots) || update.pinSlots < 0) {
        throw new Error(`pinSlots must be a non-negative integer, got ${update.pinSlots}`)
      }
      this.board.pinSlots = update.pinSlots
    }
    if (update.claimTtlMs !== undefined) {
      if (!Number.isInteger(update.claimTtlMs) || update.claimTtlMs < 1000) {
        throw new Error(`claimTtlMs must be an integer >= 1000, got ${update.claimTtlMs}`)
      }
      this.board.claimTtlMs = update.claimTtlMs
    }
    if (update.paused !== undefined) this.paused = update.paused
    if (update.turnDelayMs !== undefined) {
      if (!Number.isInteger(update.turnDelayMs) || update.turnDelayMs < 0) {
        throw new Error(`turnDelayMs must be a non-negative integer, got ${update.turnDelayMs}`)
      }
      this.turnDelayMs = update.turnDelayMs
    }
    if (update.protocolAppendix !== undefined) this.protocolAppendix = update.protocolAppendix
    if (update.hiveNames !== undefined) this.hiveNames = update.hiveNames
    if (update.holdAtCap !== undefined) this.holdAtCap = update.holdAtCap
    if (update.retire !== undefined) {
      for (const name of update.retire) {
        const r = this.retireModel(name)
        if (!r.ok) throw new Error(r.error)
      }
    }
    if (update.restore !== undefined) {
      for (const name of update.restore) {
        const r = this.restoreModel(name)
        if (!r.ok) throw new Error(r.error)
      }
    }
    if (update.stop === true) this.stop()
    return this.config()
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
        adapter: s.adapter.name,
        tier: s.tier,
      })),
      turnsTaken: this.turnsTaken,
      maxTotalTurns: Number.isFinite(this.maxTotalTurns) ? this.maxTotalTurns : null,
      maxAgents: Number.isFinite(this.maxAgents) ? this.maxAgents : null,
      lastEventId: this.log.lastId(),
    }
  }

  private setActivity(state: AgentState, activity: string): void {
    state.lastActivity = activity
    state.lastActivityAt = Date.now()
  }

  private protocol(): string {
    return this.protocolBase + (this.protocolAppendix ? `\n\n${this.protocolAppendix}` : '')
  }

  /**
   * The operator's direct line: inject a message into an agent's context.
   * Wakes the agent if it's idle; the running loop picks it up next pass.
   * Logged as a tagged system event so the intervention is on the record.
   */
  message(agentName: string, text: string): { ok: boolean; error?: string; note?: string } {
    const state = this.agents.get(agentName)
    if (state === undefined) {
      return { ok: false, error: `no agent named "${agentName}" — agents: ${[...this.agents.keys()].join(', ')}` }
    }
    if (state.status === 'done') {
      return { ok: false, error: `agent "${agentName}" has completed and cannot be messaged` }
    }
    state.messages.push({
      role: 'user',
      content: `(Direct message from the operator — the human running this swarm.)\n${text}`,
    })
    if (state.status === 'idle') state.status = 'ready'
    this.log.append({
      type: 'system',
      agent: agentName,
      channel: null,
      body: `operator → ${agentName}: ${text}`,
      tags: ['operator'],
      refs: [],
      meta: { operator: true },
    })
    this.deliverNewEvents(agentName)
    return this.running
      ? { ok: true }
      : { ok: true, note: 'no run is active — the agent will see this when the swarm runs' }
  }

  spawn(parent: string | null, spec: AgentSpec): { ok: boolean; error?: string } {
    const result = this.spawnInternal(parent, spec, spec.prompt, 'code')
    this.deliverNewEvents(null)
    return result
  }

  /**
   * End the run for good — the real terminate, distinct from the turn cap.
   * A holdAtCap swarm sitting at its cap only exits via this (or genuine
   * quiescence); a plain cap raise resumes it instead.
   */
  stop(): void {
    this.stopped = true
    this.paused = false
  }

  /** The model catalog: every pooled adapter with its manifest and retired flag. */
  catalog(): ModelCatalogEntry[] {
    return [...this.adapterPool.values()].map(a => ({
      name: a.name,
      provider: a.manifest?.provider ?? providerFromName(a.name),
      strengths: a.manifest?.strengths ?? [],
      cautions: a.manifest?.cautions ?? [],
      costClass: a.manifest?.costClass ?? null,
      retired: this.retired.has(a.name),
      isDefault: a.name === this.adapter.name,
      tiers: TIER_NAMES.filter(t => this.tiers[t]?.name === a.name),
    }))
  }

  /**
   * Retire a model: no new agent can spawn onto it (by name, tier, or
   * sampling), but agents already running on it continue. Reversible with
   * restoreModel. Logged so the decision is on the record.
   */
  retireModel(name: string, by = 'operator', reason?: string): { ok: boolean; error?: string } {
    if (!this.adapterPool.has(name)) {
      return { ok: false, error: `unknown model "${name}" — pool: ${[...this.adapterPool.keys()].join(', ')}` }
    }
    if (!this.retired.has(name)) {
      this.retired.add(name)
      this.log.append({
        type: 'system',
        agent: by,
        channel: null,
        body: `retired model "${name}"${reason ? `: ${reason}` : ''} — no new agents will spawn on it`,
        tags: ['model', 'retire'],
        refs: [],
        meta: { model: name, retired: true, reason: reason ?? null },
      })
      this.deliverNewEvents(null)
    }
    return { ok: true }
  }

  restoreModel(name: string, by = 'operator'): { ok: boolean; error?: string } {
    if (!this.adapterPool.has(name)) {
      return { ok: false, error: `unknown model "${name}"` }
    }
    if (this.retired.delete(name)) {
      this.log.append({
        type: 'system',
        agent: by,
        channel: null,
        body: `restored model "${name}" — spawnable again`,
        tags: ['model', 'restore'],
        refs: [],
        meta: { model: name, retired: false },
      })
      this.deliverNewEvents(null)
    }
    return { ok: true }
  }

  /** Any agent ready now, or idle with a queued wake — i.e. work remains. */
  private hasPendingWork(): boolean {
    for (const s of this.agents.values()) {
      if (s.status === 'ready') return true
      if (s.status === 'idle' && s.wakes.length > 0) return true
    }
    return false
  }

  private spawnInternal(
    parent: string | null,
    spec: AgentSpec,
    firstMessage: string,
    source: 'code' | 'agent',
  ): { ok: boolean; error?: string; name?: string } {
    if (this.agents.size >= this.maxAgents) {
      return { ok: false, error: `max agents (${this.maxAgents}) reached` }
    }
    if (source === 'agent' && this.hiveNames) {
      spec = { ...spec, name: generateAgentName(this.agents.keys()) }
    }
    if (this.agents.has(spec.name)) {
      return { ok: false, error: `agent "${spec.name}" already exists` }
    }

    let resolved: { adapter: ModelAdapter; tier: TierName | null }
    try {
      resolved = this.resolveAdapter(spec, source)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.adapterPool.set(resolved.adapter.name, resolved.adapter)

    this.agents.set(spec.name, {
      spec,
      status: 'ready',
      parent,
      adapter: resolved.adapter,
      tier: resolved.tier,
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
      meta: { parent, tier: resolved.tier, adapter: resolved.adapter.name },
    })
    return { ok: true, name: spec.name }
  }

  /**
   * spec.adapter wins; then a named tier; then — for agent-initiated spawns
   * only — weighted sampling; then the swarm default. Code-level spawns
   * (run(), swarm.spawn()) never get sampled: the weights model a *spawning
   * agent* declining to choose, and code callers can just say what they want.
   */
  private resolveAdapter(
    spec: AgentSpec,
    source: 'code' | 'agent',
  ): { adapter: ModelAdapter; tier: TierName | null } {
    // A code caller passing an adapter object directly is authoritative —
    // retirement only gates pool/tier/sampling picks.
    if (spec.adapter) return { adapter: spec.adapter, tier: spec.tier ?? null }

    // Explicit model by name (from the spawn verb).
    if (spec.model !== undefined) {
      const adapter = this.adapterPool.get(spec.model)
      if (adapter === undefined) {
        throw new Error(
          `unknown model "${spec.model}" — available: ${this.spawnableNames().join(', ') || '(none)'}`,
        )
      }
      if (this.retired.has(spec.model)) {
        throw new Error(`model "${spec.model}" is retired — pick another: ${this.spawnableNames().join(', ')}`)
      }
      return { adapter, tier: spec.tier ?? null }
    }

    if (spec.tier !== undefined) {
      const adapter = this.tiers[spec.tier]
      if (adapter === undefined) {
        const configured = TIER_NAMES.filter(t => this.tiers[t] !== undefined)
        throw new Error(
          configured.length === 0
            ? `tier "${spec.tier}" requested but this swarm has no tiers configured — omit tier`
            : `unknown tier "${spec.tier}" — configured tiers: ${configured.join(', ')}`,
        )
      }
      if (this.retired.has(adapter.name)) {
        throw new Error(
          `tier "${spec.tier}" points at retired model "${adapter.name}" — reassign the tier or pick another`,
        )
      }
      return { adapter, tier: spec.tier }
    }

    const weighted =
      source === 'code'
        ? []
        : TIER_NAMES.filter(
            t =>
              this.tiers[t] !== undefined &&
              (this.tierWeights[t] ?? 0) > 0 &&
              !this.retired.has(this.tiers[t]!.name),
          )
    if (weighted.length > 0) {
      const total = weighted.reduce((sum, t) => sum + this.tierWeights[t]!, 0)
      let roll = Math.random() * total
      for (const t of weighted) {
        roll -= this.tierWeights[t]!
        if (roll <= 0) return { adapter: this.tiers[t]!, tier: t }
      }
      const last = weighted[weighted.length - 1]!
      return { adapter: this.tiers[last]!, tier: last }
    }

    // Fall back to the swarm default — unless it too is retired, in which case
    // pick any spawnable model rather than silently using a retired one.
    if (!this.retired.has(this.adapter.name)) return { adapter: this.adapter, tier: null }
    for (const a of this.adapterPool.values()) {
      if (!this.retired.has(a.name)) return { adapter: a, tier: null }
    }
    throw new Error('every model is retired — restore one before spawning')
  }

  /** Pooled model names that aren't retired. */
  private spawnableNames(): string[] {
    return [...this.adapterPool.keys()].filter(n => !this.retired.has(n))
  }

  async run(task: string, root?: Partial<AgentSpec>): Promise<SwarmResult> {
    const rootSpec: AgentSpec = {
      name: root?.name ?? this.rootDefaults.name ?? 'overseer',
      role: root?.role ?? this.rootDefaults.role ?? 'coordinator',
      prompt: root?.prompt ?? this.rootDefaults.prompt ?? DEFAULT_ROOT_PROMPT,
      subscriptions: root?.subscriptions ?? this.rootDefaults.subscriptions,
      adapter: root?.adapter ?? this.rootDefaults.adapter,
    }
    const spawned = this.spawnInternal(null, rootSpec, task, 'code')
    if (!spawned.ok) throw new Error(`failed to spawn root agent: ${spawned.error}`)
    this.deliverNewEvents(null)

    const finalSummaries: Record<string, string> = {}

    this.running = true
    this.stopped = false
    try {
      outer: while (true) {
        // Paused swarms hold here — no turns, and no termination either, so
        // an operator can pause, message agents, and resume.
        while (this.paused && !this.stopped) await sleep(150)
        if (this.stopped) break

        if (this.turnsTaken >= this.maxTotalTurns) {
          // At the turn cap. With holdAtCap the run doesn't die — it waits
          // here so raising the cap (or an operator direct message) resumes
          // it, and only ends when the swarm goes quiescent or is stopped.
          // Without holdAtCap the cap is a hard stop (headless default).
          if (!this.holdAtCap || !this.hasPendingWork()) break
          await sleep(150)
          continue
        }

        // Idle agents with queued wakes become ready again.
        for (const state of this.agents.values()) {
          if (state.status === 'idle' && state.wakes.length > 0) state.status = 'ready'
        }
        const ready = [...this.agents.values()].filter(s => s.status === 'ready')
        if (ready.length === 0) break

        for (const state of ready) {
          while (this.paused && !this.stopped) await sleep(150)
          if (this.stopped) break outer
          if (this.turnsTaken >= this.maxTotalTurns) break // re-evaluate cap at top
          if (state.status !== 'ready') continue
          if (this.turnDelayMs > 0) await sleep(this.turnDelayMs)
          const summary = await this.takeTurn(state)
          if (summary !== null) finalSummaries[state.spec.name] = summary
        }
      }
    } finally {
      this.running = false
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
      result = await state.adapter.turn({
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
      // Loud, tagged, and attributed to the model — this is the signal the
      // overseer watches to reroute a wrong-fit model onto a fitter one.
      this.log.append({
        type: 'system',
        agent: name,
        channel: null,
        body: `model "${state.adapter.name}" refused ${name}'s task — its manifest may guardrail this work; consider respawning on a fitter model`,
        tags: ['refusal', 'model'],
        refs: [],
        meta: { stopReason, model: state.adapter.name, tier: state.tier },
      })
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
      // Tag with the producing adapter so a later model switch replays this
      // turn from text+toolCalls instead of another provider's raw blocks.
      providerAdapter: state.adapter.name,
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
        spawn: (parent, spec) => this.spawnInternal(parent, spec, spec.prompt, 'agent'),
        addSubscription: (agentName, filter) => {
          this.agents.get(agentName)?.subscriptions.push(filter)
        },
        agentNames: () => [...this.agents.keys()],
        subscriptionsOf: agentName => this.agents.get(agentName)?.subscriptions ?? [],
        catalog: () => this.catalog(),
        retireModel: (n, by, reason) => this.retireModel(n, by, reason),
        restoreModel: (n, by) => this.restoreModel(n, by),
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
      this.protocol() +
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Best-effort provider label for adapters without a manifest (e.g. 'anthropic:claude-...'). */
function providerFromName(name: string): string {
  const colon = name.indexOf(':')
  return colon > 0 ? name.slice(0, colon) : name
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
