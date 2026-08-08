# swarmlord

![swarmlord](assets/swarmlord.png)

A composer framework for agent swarms. The substrate is an append-only log of
typed events; every coordination model — blackboard, mailbox, task queue,
delegation — is a view over that log. Agents run concurrently, coordinate
through shared channels, and can spawn new agents at runtime. The framework
enforces backstops (max agents, max total turns), not throttles: it solves
attention, not bandwidth.

Named for the Swarmlord, the Tyranid hive tyrant that coordinates the swarm.

## Design principles

- **Event log as substrate.** Everything is an append-only stream of typed
  events. Blackboard is "filter by channel", a mailbox is "filter by
  addressee", a task queue is "task events not yet claimed". Replay,
  observability, and audit fall out for free.
- **Solve attention, not bandwidth.** Never throttle writes. Make reading
  cheap and targeted instead: self-describing channels, standing subscriptions,
  pins with limited slots, digests. When agents start naming channels
  `zz-urgent-READ-THIS` to game sort order, that isn't misbehavior — it's a
  signal that a real salience mechanism is missing. Build the mechanism.
- **Write-through checks.** Duplication happens when writing is cheaper than
  checking, so the check is fused into the write path, same round trip:
  `create_channel` searches for near-matches and returns them with the failed
  create (re-assert with `force` to create anyway); `post` content-hashes the
  body; `claim` tells you who already holds the task.
- **Convergence is signal.** Two agents independently reaching the same
  conclusion is evidence, not waste. Exact duplicate posts are *linked* to the
  original, never silently deduped or blocked. The sin is unknowing
  duplication, so the substrate informs.
- **Informed claims, not locks.** Claiming a task another agent holds returns
  the holder list instead of a grant. A second agent can still `join` — but it
  does so knowingly.
- **Cite, don't copy.** Event ids are first-class citations (`refs`). Post a
  finding once, reference it everywhere else.
- **Emergent taxonomy, curated not gated.** The framework provides the card
  catalog — channels, manifests, tags, search. The swarm decides what the
  sections are. The librarian pattern tends the catalog, merges duplicate
  channels, and posts digests, but can never block anything.
- **Emergent spawning.** Any agent can spawn any other. The framework enforces
  only backstops. Spawn events are public, so the population is as
  discoverable as the conversation.

## Quick start

```
npm install swarmlord
```

Set `ANTHROPIC_API_KEY` in your environment (the Anthropic adapter uses the
SDK's standard env resolution).

```ts
import { Swarm, AnthropicAdapter, librarianSpec } from 'swarmlord'

const swarm = new Swarm({
  adapter: new AnthropicAdapter({ model: 'claude-opus-4-8' }),
  dbPath: 'swarm.db',          // omit for in-memory
  maxAgents: 16,
  maxTotalTurns: 120,
  onEvent: evt => console.log(`[${evt.type}] ${evt.agent}: ${evt.body.slice(0, 80)}`),
})

// The librarian curates channels and posts digests. Optional but recommended.
swarm.spawn(null, librarianSpec())

const result = await swarm.run(
  'Survey the current state of open-weight code models. ' +
  'Spawn researchers for benchmarks, licensing, and deployment; ' +
  'converge on a summary in a findings channel.',
)

console.log(result.finalSummaries)
console.log(`${result.turns} turns, ${result.agents.length} agents, ${result.events} events`)
```

A fuller demo lives in `examples/research-swarm.ts`:

```
ANTHROPIC_API_KEY=... npx tsx examples/research-swarm.ts
```

## Watching the swarm

The built-in viewer is a healbot-style dashboard for a running swarm: raid
frames for every agent showing live status and current activity, a live board
feed with channel tabs and pins, all pushed over SSE straight from the event
log. There is no separate instrumentation layer — the viewer is just another
log consumer, reading the same events the agents do.

```ts
const viewer = await startViewer(swarm)
console.log(viewer.url)   // http://127.0.0.1:7717
```

Try it on the demo:

```
ANTHROPIC_API_KEY=... npx tsx examples/research-swarm.ts --view
```

## Managing swarms

One process, many swarms: the `Hive` keeps each swarm as a sqlite event log on
disk plus a metadata record. Create runs a new swarm, stop winds one down,
archive retires it, delete removes it — and archived or finished swarms stay
fully inspectable, because the log is the artifact.

```ts
import { Hive, startHive } from 'swarmlord'

const hive = new Hive({
  dir: 'swarms',              // one .db per swarm, plus a hive.json index
  createSwarm: dbPath => {
    const swarm = new Swarm({ adapter: new AnthropicAdapter(), dbPath /* , ... */ })
    swarm.spawn(null, librarianSpec())
    return swarm
  },
})

const handle = await startHive(hive)
console.log(handle.url)       // home screen: create, watch, stop, archive
```

`startHive` serves the same dashboard as `startViewer`, fronted by a home
screen listing every swarm; each entry opens the full live view — or the
post-mortem view of a finished run. Try it:

```
ANTHROPIC_API_KEY=... npx tsx examples/hive.ts
```

## Configuration

Everything tunable lives on `SwarmOptions`:

```ts
const swarm = new Swarm({
  adapter: new AnthropicAdapter(),      // swarm-wide default model
  dbPath: 'swarm.db',                   // omit for in-memory
  maxAgents: 16,                        // spawn backstop
  maxTotalTurns: 120,                   // turn backstop across all agents

  // The overseer: name, role, prompt, seeded subscriptions. run()'s second
  // argument overrides these field by field.
  root: {
    name: 'hive-tyrant',
    prompt: 'Coordinate the survey. Spawn one scout per region; keep a findings channel.',
    subscriptions: [
      { channels: ['findings'] },       // wake on posts to #findings
      { types: ['agent_done'] },        // wake when any worker completes
    ],
  },

  // The protocol preamble is the shared rulebook in every agent's system
  // prompt. Replace it wholesale, or keep it and append house rules.
  // import { PROTOCOL_PREAMBLE, DEFAULT_ROOT_PROMPT } from 'swarmlord' to extend.
  protocolAppendix: 'Always write findings in English. Cite sources with URLs.',

  pinSlots: 3,                          // pin scarcity per agent
  claimTtlMs: 300_000,                  // claim lease duration
  turnDelayMs: 0,                       // pause before each turn — slow a swarm down to watch it
  hiveNames: true,                      // agent-initiated spawns always get generated hive names
  onEvent: evt => { /* every appended event */ },
  onTurn: info => { /* every adapter turn */ },
})
```

Most of this is live: `swarm.configure({...})` adjusts `maxAgents`,
`maxTotalTurns`, `pinSlots`, `claimTtlMs`, `tierWeights`, `protocolAppendix`,
`turnDelayMs`, `hiveNames`, tier assignments, and `paused` (freeze/resume
turn-taking) on a running swarm — the viewer's settings drawer is a front-end
for it. There is also an operator direct line: `swarm.message(agent, text)`
injects a message straight into an agent's context, delivered before its next
turn; the viewer's console does the same.

### Tiers

Swarms mix model classes through three named tiers — castes by expense and
proficiency:

```ts
const swarm = new Swarm({
  adapter: new AnthropicAdapter(),   // default when no tier applies
  tiers: {
    heavy:    new AnthropicAdapter(),                                // deep synthesis, judgment
    standard: new AnthropicAdapter({ model: 'claude-sonnet-4-6' }),  // everyday work
    light:    new AnthropicAdapter({ model: 'claude-haiku-4-5' }),   // scanning, mechanical tasks
  },
  tierWeights: { standard: 3, light: 1 },
})
```

The *spawning agent* chooses: the `spawn` verb takes `tier`, and its
description teaches the trade-off (don't burn heavy on a listing job, don't
send light to synthesize). When a spawn names no tier, `tierWeights` decides
by weighted sample — but only for agent-initiated spawns. Code-level spawns
(`run()`, `swarm.spawn(...)`) use the swarm default unless you say otherwise:
the weights model an agent declining to choose, not your own calls.

Any spec passed from code can also carry its own adapter directly —
`swarm.spawn(null, { ..., adapter: someAdapter })` — which wins over tiers.
Snapshots report each agent's tier and adapter, and the viewer badges them.

Subscriptions are how agents wake: an idle agent resumes only when an event
matching one of its standing queries arrives (or when anything is pinned —
pins cut through all filters). Seed them in the spec as above, or let agents
manage their own with the `subscribe` verb. Bookkeeping events (`agent_idle`,
`agent_done`, `claimed`, `spawned`, ...) must be named explicitly in `types` —
catch-all subscriptions never match them, so idle chatter can't livelock the
swarm. Idling with no subscriptions at all is refused: the agent is told to
subscribe first or call `complete`.

## Providers and model choice

A swarm member is anything implementing `ModelAdapter` — a system prompt, a
message history, and a tool list in, text plus tool calls out. Any provider
fits; the runtime never sees an SDK.

```ts
interface ModelAdapter {
  readonly name: string
  readonly manifest?: ModelManifest
  turn(req: TurnRequest): Promise<TurnResult>
}
```

Built-in adapters, all with the same constructor shape (`{ model?, apiKey?,
maxTokens? }`, plus an optional `manifest` override):

- `AnthropicAdapter` — Claude (`@anthropic-ai/sdk`).
- `OpenAIAdapter` — GPT (`openai`).
- `GeminiAdapter` — Gemini (`@google/genai`).
- `OpenRouterAdapter` — a gateway to many models behind one key. Point `model`
  at any OpenRouter slug. It's OpenAI-compatible, so a **local** server (Ollama,
  vLLM, LM Studio) works the same way — set `baseURL` on `OpenRouterAdapter` (or
  `OpenAIAdapter`) at the local endpoint and use its model name.

Each adapter publishes a `ModelManifest` so agents can choose it well:

```ts
interface ModelManifest {
  provider: string
  strengths: string[]   // 'code', 'long-horizon synthesis', 'vision', ...
  cautions: string[]    // where it's weak or restricted — guardrail edges live here
  costClass: 'cheap' | 'moderate' | 'expensive'
}
```

`cautions` is the important field: it's where "strict guardrails, refuses
exploit analysis" or "weak at strict JSON" lives, in words a spawner reasons
over. Put non-default adapters in `SwarmOptions.adapters` (see
`examples/hive.ts`, which adds OpenAI/Gemini/OpenRouter when their keys are
present); tiers can also point at any of them.

**How an agent chooses.** `list_models` returns the catalog — every pooled
model with its provider, strengths, cautions, cost, and whether it's retired.
The agent then spawns with `model:<name>` for a specific pick or `tier:` for a
coarse one (omit both to accept the default), reading the cautions so it never
hands a model a task its manifest warns against.

**When a pick is wrong.** A model that refuses (its manifest guardrails the
work) produces a loud, tagged `refusal` event attributed to that model, and the
agent is idled — refusals are *not* auto-retried past. The overseer watches for
them: it judges whether it was a capability gap (reroute the task onto a fitter
model) or a correct refusal (respect it), and if a model is *persistently*
wrong for this swarm's work it calls `retire_model` so nothing else spawns on
it (running agents finish; `restore` re-enables it).

**Across a model switch.** An agent's history is safe to carry between
providers: every recorded assistant turn is tagged with the adapter that
produced it, and an adapter replays another provider's raw blocks only when the
tag is its own — otherwise it reconstructs the turn from plain text plus tool
calls, so (e.g.) Anthropic thinking-block signatures never leak into an OpenAI
request.

## The verbs

Agents see the substrate through ten tools:

| verb | input | semantics |
|---|---|---|
| `list_channels` | `{}` | catalog with purposes and stats |
| `create_channel` | `{name, purpose, tags?, force?}` | write-through search; `created: false` returns similar channels |
| `post` | `{channel, body, tags?, refs?}` | returns event id, plus duplicate link if any |
| `query` | `{text?, channel?, types?, tags?, since_id?, limit?}` | search the log |
| `subscribe` | `{channels?, types?, tags?, text_includes?}` | add a standing query for this agent |
| `pin` | `{event_id, unpin?}` | limited slots per agent; error lists current pins |
| `claim` | `{event_id, join?, release?}` | informed claim / join / release |
| `merge_channels` | `{from, to}` | alias `from` → `to` |
| `list_models` | `{}` | model catalog: provider, strengths, cautions, cost, retired flag |
| `spawn` | `{name?, role, prompt, model?, tier?, subscriptions?}` | new agent on a chosen model/tier; capped by `maxAgents` |
| `retire_model` | `{model, reason?, restore?}` | make a model unspawnable (or `restore` it); running agents keep going |
| `idle` | `{reason?}` | sleep until a subscribed event arrives |
| `complete` | `{summary}` | agent is done for good; summary recorded |

`spawn`'s `name` is optional — omitted names are generated (vexeth, skarnix, ...).

## Architecture

```
┌─────────────────────────────────────────────┐
│ your swarm definition (specs, subscriptions)│
├─────────────────────────────────────────────┤
│ patterns          librarian, more to come   │
├─────────────────────────────────────────────┤
│ views             board · mailbox · queue   │
├─────────────────────────────────────────────┤
│ event log         append-only, sqlite, FTS  │
└─────────────────────────────────────────────┘
```

- **Event log** (`core/log.ts`) — append-only, persisted with `node:sqlite`,
  full-text searchable. Every mutation in the system lands here, so a finished
  run is a complete, replayable audit trail: who posted what, who claimed
  what, who spawned whom, in order.
- **Views** (`core/board.ts`) — channels, pins, claims, and merges are
  interpretations of log events, not separate stores of truth.
- **Patterns** (`patterns/`) — roles built entirely on the public verbs. The
  librarian is the first; it has no privileged API.
- **Your swarm** — agent specs, role prompts, and subscriptions composed on
  top. Any model works via the `ModelAdapter` interface; Anthropic, OpenAI,
  Gemini, OpenRouter (+ local via an OpenAI-compatible `baseURL`), and mock
  adapters ship in the box. See *Providers and model choice* above.

## Status

v0.1. Experimental. The API will move. MIT.
