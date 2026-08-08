# swarmlord — design

A generic agent-swarm composer. N agents run concurrently, coordinate through a
shared substrate, and can spawn new agents at runtime. The framework owns the
substrate; coordination models are views over it.

## Principles

1. **Event log as substrate.** Everything is an append-only stream of typed
   events. Blackboard, mailbox, task queue, and delegation are all *views* over
   the log. Replay, observability, and time-travel debugging fall out for free.
2. **Solve attention, not bandwidth.** Never throttle writes. Make reading
   cheap, targeted, and self-describing: self-describing channels, standing
   queries (subscriptions), salience mechanisms (pins with limited slots),
   digests. Agents inventing `zz-urgent` naming hacks is a signal a salience
   affordance is missing.
3. **Duplication happens when writing is cheaper than checking.** Fuse the
   check into the write path, same round trip:
   - `create_channel` does write-through search — near-matches come back with
     the failed create; re-assert with `force` to create anyway.
   - `post` content-hashes the body — exact dupes are *linked*, never blocked.
   - `claim` is informed, not exclusive — a second claimant is told who else
     holds the task and must consciously `join`.
4. **Convergence is signal.** Two agents independently reaching the same
   conclusion is evidence, not waste. The substrate links duplicates, it does
   not silently dedupe. The sin is *unknowing* duplication, so claims inform.
5. **Cite, don't copy.** Event ids are first-class citations (`refs`).
6. **Emergent spawning.** Any agent can spawn any other; the framework enforces
   only backstops (max agents, max total turns). Spawn events are public — the
   population is as discoverable as the conversation.
7. **Emergent taxonomy.** The framework provides the card catalog (channels,
   manifests, tags, search); the swarm decides what the sections are. The
   librarian is a curator, never a gatekeeper.
8. **Provider-agnostic.** Agents are anything implementing `ModelAdapter`.

## Module map

```
src/
  core/events.ts         # types: SwarmEvent, EventFilter, ChannelManifest  (DONE)
  core/subscriptions.ts  # SubscriptionFilter + matchesFilter               (DONE)
  core/log.ts            # EventLog — node:sqlite persistence + FTS5
  core/board.ts          # Blackboard — channels, claims, pins, merge
  core/verbs.ts          # tool defs + dispatcher (the agent-facing verbs)
  core/names.ts          # generateAgentName — hive-flavored names for unnamed spawns
  core/runtime.ts        # Swarm — scheduling, spawning, subscription wakes
  viewer/ui.ts           # VIEWER_HTML — single-file dashboard page
  viewer/server.ts       # startViewer — node:http server + SSE over the log
  adapters/types.ts      # ModelAdapter neutral interface                   (DONE)
  adapters/anthropic.ts  # Claude adapter (@anthropic-ai/sdk)
  adapters/mock.ts       # scripted adapter for tests/offline demo
  patterns/librarian.ts  # curator role built on the public verbs
  index.ts               # public re-exports
examples/research-swarm.ts
test/*.test.ts
```

## Implementation constraints

- Node >= 22.5, TypeScript strict, ESM with `module: NodeNext` — **relative
  imports must use `.js` extensions** (`from './events.js'`).
- Persistence via **`node:sqlite`** (`DatabaseSync`) — no native deps.
  FTS5 is available. `stmt.run/get/all`, `db.exec`, positional `?` params.
- No runtime dependencies besides `@anthropic-ai/sdk` (used only by the
  Anthropic adapter).

## Public API contracts

Implementations must match these exactly — other modules are written against
them in parallel.

### `core/log.ts`

```ts
export class EventLog {
  constructor(path?: string)            // default ':memory:'
  readonly db: DatabaseSync             // shared handle; Blackboard adds tables
  append(evt: NewEvent): SwarmEvent     // assigns id/ts; computes duplicateOf for 'post' events
  get(id: number): SwarmEvent | null
  query(filter?: EventFilter): SwarmEvent[]  // ascending id, limit default 50
  lastId(): number
  close(): void
}
```

- Dedup: for `type: 'post'`, hash the whitespace-normalized lowercased body
  (sha256). First event with the same hash becomes `duplicateOf`. The event is
  still inserted.
- `EventFilter.text` searches an FTS5 index over body+tags. Sanitize the query:
  split into word tokens, quote each, join with `OR`.
- tags/refs/meta stored as JSON text columns.

### `core/board.ts`

```ts
export interface BoardOptions { pinSlots?: number /* 3 */; claimTtlMs?: number /* 300_000 */ }

export type CreateChannelResult =
  | { created: true; channel: ChannelInfo; event: SwarmEvent }
  | { created: false; similar: ChannelInfo[] }   // write-through search hit

export interface PostResult { event: SwarmEvent; duplicateOf: SwarmEvent | null }
export interface ClaimResult { granted: boolean; holders: string[]; event: SwarmEvent | null }

export class Blackboard {
  constructor(log: EventLog, opts?: BoardOptions)
  createChannel(agent: string, manifest: ChannelManifest, force?: boolean): CreateChannelResult
  resolve(name: string): string | null       // follows alias chain; null if unknown
  catalog(): ChannelInfo[]                   // canonical channels only, with stats
  post(agent: string, channel: string, body: string,
       opts?: { tags?: string[]; refs?: number[] }): PostResult   // throws if channel unknown
  pin(agent: string, eventId: number): { pinned: boolean; error?: string; pins: number[] }
  unpin(agent: string, eventId: number): void
  pins(): Array<{ eventId: number; agent: string }>
  claim(agent: string, taskEventId: number, join?: boolean): ClaimResult
  release(agent: string, taskEventId: number): void
  activeClaims(taskEventId: number): string[]    // unexpired, unreleased holders
  merge(agent: string, from: string, to: string): SwarmEvent  // alias `from` -> `to`; throws on unknown/self/cycle
}
```

- Channel-similarity: token-set Jaccard over name+purpose+tags (split on
  non-alphanumerics, lowercase), threshold ≈ 0.3, plus substring name match.
  `force: true` skips the check.
- `post` resolves aliases (posting to a merged channel lands in the canonical
  one). Posting logs a `post` event with `channel` set to the canonical name.
- Claims are leases: expire after `claimTtlMs`, releasable early. Claiming an
  already-claimed task without `join` returns `{granted: false, holders}` —
  the informed-refusal. Same agent re-claiming renews its lease.
- Every board mutation (channel create/merge, pin, claim/release) also appends
  a corresponding event to the log, so the log stays the complete audit trail.

### `core/verbs.ts` + `core/runtime.ts`

```ts
export interface AgentSpec {
  name: string
  role: string          // short human-readable role, e.g. 'researcher'
  prompt: string        // role instructions appended to the protocol system prompt
  subscriptions?: SubscriptionFilter[]
}

export interface SwarmOptions {
  adapter: ModelAdapter
  dbPath?: string
  maxAgents?: number        // default 32
  maxTotalTurns?: number    // default 200 (across all agents)
  pinSlots?: number
  claimTtlMs?: number
  onEvent?: (evt: SwarmEvent) => void   // fires for every appended event
  onTurn?: (info: { agent: string; turn: number; text: string; toolCalls: ToolCall[] }) => void
}

export interface SwarmResult {
  turns: number
  agents: string[]
  finalSummaries: Record<string, string>  // agent -> `complete` summary
  events: number
}

export class Swarm {
  constructor(opts: SwarmOptions)
  readonly log: EventLog
  readonly board: Blackboard
  spawn(parent: string | null, spec: AgentSpec): { ok: boolean; error?: string }
  run(task: string, root?: Partial<AgentSpec>): Promise<SwarmResult>
}
```

Agent-facing verbs (tools). Results are JSON strings.

| tool | input | semantics |
|---|---|---|
| `list_channels` | `{}` | catalog with purposes + stats |
| `create_channel` | `{name, purpose, tags?, force?}` | write-through search; `created:false` returns similar channels |
| `post` | `{channel, body, tags?, refs?}` | returns event id + duplicate link if any |
| `query` | `{text?, channel?, types?, tags?, since_id?, limit?}` | search the log |
| `subscribe` | `{channels?, types?, tags?, text_includes?}` | add a standing query for this agent |
| `pin` | `{event_id, unpin?}` | limited slots per agent; error lists current pins |
| `claim` | `{event_id, join?, release?}` | informed claim / join / release |
| `merge_channels` | `{from, to}` | alias from → to |
| `spawn` | `{name?, role, prompt, subscriptions?}` | new agent; capped by maxAgents; omitted name is generated (core/names.ts) |
| `idle` | `{reason?}` | sleep until a subscribed event arrives |
| `complete` | `{summary}` | agent is done for good; summary recorded |

Runtime loop:
- `run(task)` spawns the root agent (default name `overseer`) with the task as
  its first user message, then round-robins over `ready` agents, one adapter
  turn each, executing tool calls sequentially and feeding results back as a
  `tool_results` message.
- A turn with **no tool calls** auto-idles the agent (with a note appended to
  its history that it was idled and will wake on subscriptions).
- After each turn, new log events (excluding the acting agent's own) are
  matched against agents' subscriptions; matches queue as wakes. Idle agents
  with queued wakes become ready; wake events are delivered as a compact user
  message (id, type, agent, channel, body excerpt) before their next turn.
- Spawned agents get a `spawned` event on the log (body = role+prompt summary,
  meta.parent) and start ready, with their `prompt` as first user message.
- The run ends when all agents are `idle` with no pending wakes / `done`, or
  when `maxTotalTurns` is hit. `spawn` past `maxAgents` returns an error the
  agent sees as a tool result.
- The protocol system prompt (same for all agents, role prompt appended) must
  teach: check the catalog/query before creating or posting, cite event ids
  via refs, claim before working a task and join consciously, post findings
  once and reference elsewhere, spawn for parallelizable work, idle to wait,
  complete when finished.

### `adapters/anthropic.ts`

```ts
export interface AnthropicAdapterOptions {
  model?: string       // default 'claude-opus-4-8'
  apiKey?: string      // default: SDK env resolution
  maxTokens?: number   // default 16000
}
export class AnthropicAdapter implements ModelAdapter { ... }
```

- Uses `@anthropic-ai/sdk` `client.messages.create` with
  `thinking: {type: 'adaptive'}`, tools mapped to `{name, description,
  input_schema}`. No `temperature`/`top_p`. Map neutral messages:
  `assistant` → text + `tool_use` blocks; `tool_results` → user turn of
  `tool_result` blocks. Parse response content blocks back to text +
  ToolCall[]. Narrow content blocks by `.type`.

### `adapters/mock.ts`

```ts
export type MockHandler = (req: TurnRequest, callIndex: number) => TurnResult
export class MockAdapter implements ModelAdapter {
  constructor(handler: MockHandler)
}
```

Plus a small helper `turnOf(toolCalls: Array<{name: string; input: Record<string, unknown>}>, text?: string): TurnResult`
that fabricates ids (`tc-1`, `tc-2`, ...).

### `patterns/librarian.ts`

`export function librarianSpec(overrides?: Partial<AgentSpec>): AgentSpec` — a
curator role: subscribes to all `post`/`channel_created` events, maintains
digest posts per active channel, merges duplicate channels, tends the catalog.
Explicitly instructed it can never block anything.

### `index.ts`

Re-export the public surface of every module above.

## Viewer

A zero-dependency web dashboard (`node:http` only) for watching a swarm live.
It has no privileged hooks — it is just another consumer of the event log and
`Swarm.snapshot()`.

```ts
// src/viewer/ui.ts
export const VIEWER_HTML: string   // complete single-file HTML page

// src/viewer/server.ts
export interface ViewerOptions { port?: number /* default 7717 */; host?: string /* default '127.0.0.1' */ }
export interface ViewerHandle { url: string; port: number; close(): Promise<void> }
export function startViewer(swarm: Swarm, opts?: ViewerOptions): Promise<ViewerHandle>
```

HTTP endpoints:

| endpoint | response |
|---|---|
| `GET /` | `text/html`, `VIEWER_HTML` |
| `GET /api/state` | JSON `{ snapshot: SwarmSnapshot, channels: ChannelInfo[], pins: Array<{eventId: number, agent: string}> }` |
| `GET /api/events?since_id=N&limit=M` | JSON `SwarmEvent[]` (defaults `since_id=0`, `limit=200`) |
| `GET /api/stream` | SSE. Every ~400ms an `event: tick` whose data is JSON `{ state: <same shape as /api/state>, events: SwarmEvent[] }`, where `events` are the log entries appended since this connection's cursor. The cursor starts at the `since_id` query param (default: current `lastId` — the UI fetches history via `/api/events` first). |
