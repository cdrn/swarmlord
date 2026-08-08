/**
 * The substrate: every coordination mechanism in swarmlord is a view over an
 * append-only log of typed events. A blackboard is "filter by channel", a
 * mailbox is "filter by addressee", a task queue is "task events not yet
 * claimed", delegation is "spawn events with a parent pointer".
 */

export type EventType =
  | 'post'
  | 'channel_created'
  | 'channel_merged'
  | 'pinned'
  | 'unpinned'
  | 'claimed'
  | 'claim_released'
  | 'spawned'
  | 'agent_idle'
  | 'agent_done'
  | 'system'

export interface SwarmEvent {
  id: number
  ts: number
  type: EventType
  agent: string
  channel: string | null
  body: string
  tags: string[]
  /** Event ids this event cites. Cite, don't copy. */
  refs: number[]
  meta: Record<string, unknown>
  /**
   * If the body is an exact content-hash match of an earlier post, links to
   * it. The post is still recorded — independent convergence is signal, not
   * noise — but readers can see the link.
   */
  duplicateOf: number | null
}

export type NewEvent = Omit<SwarmEvent, 'id' | 'ts' | 'duplicateOf'> & { ts?: number }

export interface EventFilter {
  /** Full-text search over body and tags (FTS5, terms OR-ed). */
  text?: string
  /** Exact single channel (sugar for a one-element `channels`). */
  channel?: string
  /** Any of these channels, matched case-insensitively. */
  channels?: string[]
  types?: EventType[]
  agent?: string
  tagsAny?: string[]
  /** Only events with id > sinceId. */
  sinceId?: number
  /** Default 50. */
  limit?: number
}

export interface ChannelManifest {
  name: string
  purpose: string
  tags: string[]
}

export interface ChannelInfo extends ChannelManifest {
  createdBy: string
  createdAt: number
  aliasOf: string | null
  eventCount: number
  lastEventAt: number | null
}
