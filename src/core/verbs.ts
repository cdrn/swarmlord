/**
 * The agent-facing verbs: tool definitions plus a dispatcher. Descriptions
 * teach the protocol (check before create, cite refs, claim before working)
 * because the tool list is the part of the system prompt agents re-read most.
 */

import type { EventType } from './events.js'
import type { SubscriptionFilter } from './subscriptions.js'
import type { ToolCall, ToolDef } from '../adapters/types.js'
import type { EventLog } from './log.js'
import type { Blackboard } from './board.js'
import type { AgentSpec } from './runtime.js'
import { generateAgentName } from './names.js'

export interface VerbContext {
  board: Blackboard
  log: EventLog
  spawn(parent: string, spec: AgentSpec): { ok: boolean; error?: string }
  addSubscription(agentName: string, filter: SubscriptionFilter): void
  /** Names of all agents currently in the swarm (for name generation). */
  agentNames(): string[]
  /** The agent's current standing queries (for the no-subscription idle guard). */
  subscriptionsOf(agentName: string): SubscriptionFilter[]
}

export interface VerbResult {
  content: string
  isError: boolean
  statusChange?: 'idle' | 'done'
  summary?: string
}

const subscriptionProps = {
  channels: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only events posted to these channels.',
  },
  types: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Only these event types (e.g. "post", "claimed", "spawned", "agent_done"). ' +
      'Bookkeeping types (claimed, claim_released, spawned, agent_idle, agent_done) ' +
      'wake you only when listed here explicitly.',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: 'Events carrying any of these tags.',
  },
  agents: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only events authored by these agents (e.g. workers you spawned).',
  },
  text_includes: {
    type: 'array',
    items: { type: 'string' },
    description: 'Case-insensitive substrings; any one matching the body suffices.',
  },
} as const

export const toolDefs: ToolDef[] = [
  {
    name: 'list_channels',
    description:
      'List the channel catalog: every channel with its purpose, tags, and activity stats. ' +
      'Check this BEFORE creating a channel or posting — the channel you need probably ' +
      'already exists, and posting in the right place is how others find your work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_channel',
    description:
      'Create a new channel with a name, purpose, and tags. Only after checking ' +
      'list_channels. The create does a similarity search first: if near-matching ' +
      'channels exist you get them back instead of a new channel — use one of those, ' +
      'or re-run with force:true only if your topic is genuinely distinct.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short, descriptive channel name.' },
        purpose: { type: 'string', description: 'One or two sentences: what belongs here.' },
        tags: { type: 'array', items: { type: 'string' } },
        force: {
          type: 'boolean',
          description: 'Create even if similar channels exist. Use consciously.',
        },
      },
      required: ['name', 'purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'post',
    description:
      'Post a message to a channel. Post a finding ONCE, in the best-fitting channel; ' +
      'elsewhere, cite it by event id via refs instead of copying the text. Refs are how ' +
      'the swarm builds on prior work — always cite the events you used. If your body ' +
      'exactly matches an earlier post you get a duplicate_of link back; that is signal ' +
      '(independent convergence), not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        refs: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Event ids this post cites or builds on. Cite, do not copy.',
        },
      },
      required: ['channel', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'query',
    description:
      'Search the event log. Use this BEFORE starting work to see what already exists, ' +
      'and to pull in results you plan to cite. Filter by full-text, channel, event ' +
      'types, tags, or since_id (only events after a known id). Results come back ' +
      'oldest-first with their ids — cite those ids in refs when you use them.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Full-text search over bodies and tags.' },
        channel: { type: 'string' },
        types: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        since_id: { type: 'integer', description: 'Only events with id greater than this.' },
        limit: { type: 'integer', description: 'Max results, default 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'subscribe',
    description:
      'Add a standing query: matching future events will wake you and appear in your ' +
      'context. Subscribe to what you actually need to react to — the channels you work ' +
      'in, tags you own, agents you delegated to. Subscribe BEFORE you idle, or nothing ' +
      'will ever wake you.',
    inputSchema: {
      type: 'object',
      properties: subscriptionProps,
      additionalProperties: false,
    },
  },
  {
    name: 'pin',
    description:
      'Pin an event to mark it as high-salience for the whole swarm. You have a small ' +
      'fixed number of pin slots, so a pin is a costly signal — spend it on the few ' +
      'things everyone should see. Pass unpin:true to free a slot.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'integer' },
        unpin: { type: 'boolean', description: 'Remove your pin from this event instead.' },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'claim',
    description:
      'Claim a task event BEFORE working on it, so effort is visible and duplication ' +
      'is knowing, not accidental. If someone already holds the claim you are told who ' +
      '— read their work first, then either pick a different task or join:true to work ' +
      'it alongside them consciously. Claims are time-limited leases; re-claim to renew, ' +
      'or release:true when you stop.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'integer', description: 'The event id of the task to claim.' },
        join: {
          type: 'boolean',
          description: 'Join an already-claimed task deliberately, aware of the other holders.',
        },
        release: { type: 'boolean', description: 'Release your claim on this task.' },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_channels',
    description:
      'Merge one channel into another: "from" becomes an alias of "to", and future posts ' +
      'to it land in "to". Use when two channels have converged on the same topic. ' +
      'Nothing is deleted — history stays where it was written.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Channel to be aliased away.' },
        to: { type: 'string', description: 'Canonical channel that absorbs it.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'spawn',
    description:
      'Spawn a new agent into the swarm. Use for parallelizable work: give it a clear ' +
      'name, a role, and a prompt that says what to do, where to post results, and to ' +
      'call complete when finished. Optionally seed its subscriptions. Spawns are public ' +
      'events — the population is as discoverable as the conversation. Capped by a ' +
      'max-agents backstop.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique agent name. Omit to have one generated.',
        },
        role: { type: 'string', description: 'Short role, e.g. "researcher".' },
        prompt: { type: 'string', description: 'Role instructions; delivered as its first message.' },
        subscriptions: {
          type: 'array',
          description: 'Standing queries to seed the new agent with.',
          items: {
            type: 'object',
            properties: subscriptionProps,
            additionalProperties: false,
          },
        },
      },
      required: ['role', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'idle',
    description:
      'Go to sleep until an event matching one of your subscriptions arrives. Use when ' +
      'you are waiting on others rather than done. Make sure you have subscriptions ' +
      'covering what you are waiting for, or you will never wake.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What you are waiting for.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'complete',
    description:
      'Declare yourself done for good and record a final summary of what you did and ' +
      'where the results live (cite event ids and channels). You will not run again. ' +
      'Use when your work is finished, not when you are merely waiting — use idle for that.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]

function reqString(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string field "${key}"`)
  }
  return v
}

function reqInt(input: Record<string, unknown>, key: string): number {
  const v = input[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`missing required integer field "${key}"`)
  }
  return v
}

function optStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const v = input[key]
  return Array.isArray(v) ? v.map(String) : undefined
}

/**
 * Map tool-facing subscription shape (tags/text_includes) onto
 * SubscriptionFilter. Empty arrays count as "not provided" — LLMs frequently
 * emit them for optional array fields, and an empty clause would make the
 * whole filter unmatchable ([].some() is always false).
 */
function toSubscriptionFilter(raw: Record<string, unknown>): SubscriptionFilter {
  const filter: SubscriptionFilter = {}
  const channels = optStrings(raw, 'channels')
  const types = optStrings(raw, 'types')
  const tags = optStrings(raw, 'tags')
  const agents = optStrings(raw, 'agents')
  const textIncludes = optStrings(raw, 'text_includes')
  if (channels?.length) filter.channels = channels
  if (types?.length) filter.types = types as EventType[]
  if (tags?.length) filter.tagsAny = tags
  if (agents?.length) filter.agents = agents
  if (textIncludes?.length) filter.textIncludes = textIncludes
  return filter
}

const EMPTY_FILTER_ERROR =
  'subscription filter must specify at least one non-empty constraint ' +
  '(channels, types, tags, agents, or text_includes) — a match-everything ' +
  'subscription would wake you on every event. Scope it to what you must react to.'

function ok(payload: unknown, extra?: Partial<VerbResult>): VerbResult {
  return { content: JSON.stringify(payload), isError: false, ...extra }
}

function err(payload: unknown): VerbResult {
  return { content: JSON.stringify(payload), isError: true }
}

export function executeVerb(ctx: VerbContext, agentName: string, call: ToolCall): VerbResult {
  const input = call.input ?? {}
  try {
    switch (call.name) {
      case 'list_channels': {
        return ok({ channels: ctx.board.catalog() })
      }

      case 'create_channel': {
        const manifest = {
          name: reqString(input, 'name'),
          purpose: reqString(input, 'purpose'),
          tags: optStrings(input, 'tags') ?? [],
        }
        const result = ctx.board.createChannel(agentName, manifest, input.force === true)
        if (result.created) {
          return ok({ created: true, channel: result.channel, event_id: result.event.id })
        }
        if (result.reason === 'name_taken') {
          return ok({
            created: false,
            existing: result.existing,
            note:
              `The name "${manifest.name}" is already taken (canonical channel ` +
              `"${result.existing.name}"). force cannot override an exact name — post ` +
              'to the existing channel or pick a different name.',
          })
        }
        return ok({
          created: false,
          similar: result.similar,
          note:
            'Similar channels already exist. Post to one of them, or re-run with ' +
            'force:true only if your topic is genuinely distinct.',
        })
      }

      case 'post': {
        const result = ctx.board.post(agentName, reqString(input, 'channel'), reqString(input, 'body'), {
          tags: optStrings(input, 'tags'),
          refs: Array.isArray(input.refs) ? (input.refs as number[]) : undefined,
        })
        return ok({
          event_id: result.event.id,
          channel: result.event.channel,
          duplicate_of: result.duplicateOf ? result.duplicateOf.id : null,
          ...(result.duplicateOf
            ? {
                note:
                  `Exact content match of event #${result.duplicateOf.id} by ` +
                  `${result.duplicateOf.agent}. Both are recorded and linked — convergence is signal.`,
              }
            : {}),
        })
      }

      case 'query': {
        const channel = typeof input.channel === 'string' ? input.channel : undefined
        const events = ctx.log.query({
          text: typeof input.text === 'string' ? input.text : undefined,
          // The whole alias family, so merged channels read as one history;
          // fall back to the literal name when the catalog doesn't know it.
          channels:
            channel === undefined ? undefined : (ctx.board.channelFamily(channel) ?? [channel]),
          types: optStrings(input, 'types') as EventType[] | undefined,
          tagsAny: optStrings(input, 'tags'),
          sinceId: typeof input.since_id === 'number' ? input.since_id : undefined,
          limit: typeof input.limit === 'number' ? input.limit : undefined,
        })
        return ok({
          count: events.length,
          events: events.map(e => ({
            id: e.id,
            type: e.type,
            agent: e.agent,
            channel: e.channel,
            body: e.body,
            tags: e.tags,
            refs: e.refs,
            duplicate_of: e.duplicateOf,
          })),
        })
      }

      case 'subscribe': {
        const filter = toSubscriptionFilter(input)
        if (Object.keys(filter).length === 0) {
          return err({ subscribed: false, error: EMPTY_FILTER_ERROR })
        }
        ctx.addSubscription(agentName, filter)
        return ok({ subscribed: true, filter })
      }

      case 'pin': {
        const eventId = reqInt(input, 'event_id')
        if (input.unpin === true) {
          ctx.board.unpin(agentName, eventId)
          return ok({ unpinned: true, event_id: eventId })
        }
        const result = ctx.board.pin(agentName, eventId)
        if (!result.pinned) {
          return err({ pinned: false, error: result.error, pins: result.pins })
        }
        return ok({ pinned: true, event_id: eventId, pins: result.pins })
      }

      case 'claim': {
        const eventId = reqInt(input, 'event_id')
        if (input.release === true) {
          ctx.board.release(agentName, eventId)
          return ok({ released: true, event_id: eventId })
        }
        const result = ctx.board.claim(agentName, eventId, input.join === true)
        if (!result.granted) {
          if (result.error !== undefined) {
            return err({ granted: false, error: `${result.error} — check the event id` })
          }
          // Informed refusal, not an error: the agent must decide to join or move on.
          return ok({
            granted: false,
            holders: result.holders,
            note:
              'Task already claimed. Read the holders’ work first, then either pick ' +
              'other work or re-claim with join:true to work it alongside them consciously.',
          })
        }
        return ok({ granted: true, holders: result.holders, event_id: result.event?.id ?? null })
      }

      case 'merge_channels': {
        const event = ctx.board.merge(agentName, reqString(input, 'from'), reqString(input, 'to'))
        return ok({ merged: true, from: input.from, to: input.to, event_id: event.id })
      }

      case 'spawn': {
        const subscriptions = Array.isArray(input.subscriptions)
          ? (input.subscriptions as Record<string, unknown>[]).map(toSubscriptionFilter)
          : undefined
        if (subscriptions?.some(f => Object.keys(f).length === 0)) {
          return err({ spawned: false, error: `each ${EMPTY_FILTER_ERROR}` })
        }
        const requestedName = typeof input.name === 'string' ? input.name.trim() : ''
        const spec: AgentSpec = {
          name: requestedName !== '' ? requestedName : generateAgentName(ctx.agentNames()),
          role: reqString(input, 'role'),
          prompt: reqString(input, 'prompt'),
          subscriptions,
        }
        const result = ctx.spawn(agentName, spec)
        if (!result.ok) return err({ spawned: false, error: result.error })
        return ok({ spawned: true, name: spec.name })
      }

      case 'idle': {
        const reason = typeof input.reason === 'string' ? input.reason : ''
        // Idling with no subscriptions is almost always a mistake: nothing
        // (except a pin) can ever wake this agent, and the run may end with
        // its work unfinished. Refuse so the agent self-corrects.
        if (ctx.subscriptionsOf(agentName).length === 0) {
          return err({
            idling: false,
            error:
              'You have no subscriptions — nothing would ever wake you. ' +
              'Call subscribe first (e.g. to the channels your workers post to, or ' +
              "types: ['agent_done'] to wake when they finish), then idle. " +
              'If your work is actually finished, call complete instead.',
          })
        }
        ctx.log.append({
          type: 'agent_idle',
          agent: agentName,
          channel: null,
          body: reason,
          tags: [],
          refs: [],
          meta: {},
        })
        return ok(
          { idling: true, note: 'You will wake when an event matching your subscriptions arrives.' },
          { statusChange: 'idle' },
        )
      }

      case 'complete': {
        const summary = reqString(input, 'summary')
        ctx.log.append({
          type: 'agent_done',
          agent: agentName,
          channel: null,
          body: summary,
          tags: [],
          refs: [],
          meta: {},
        })
        return ok({ completed: true }, { statusChange: 'done', summary })
      }

      default:
        return err({ error: `unknown tool "${call.name}"` })
    }
  } catch (e) {
    return err({ error: e instanceof Error ? e.message : String(e) })
  }
}
