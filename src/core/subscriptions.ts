import type { EventType, SwarmEvent } from './events.js'

/**
 * A standing query. Instead of throttling who can write, agents declare what
 * they care about and the runtime routes matching events into their context.
 * Attention routing, not rate limiting.
 */
export interface SubscriptionFilter {
  channels?: string[]
  types?: EventType[]
  tagsAny?: string[]
  agents?: string[]
  /** Case-insensitive substring match on body; any term matching suffices. */
  textIncludes?: string[]
}

/**
 * `resolveChannel` (optional) canonicalizes channel names — alias chains and
 * case — at match time, so a subscription to a pre-merge or differently-cased
 * name still fires for posts stored under the canonical one. Unknown names
 * fall back to a lowercased literal comparison.
 */
export function matchesFilter(
  filter: SubscriptionFilter,
  evt: SwarmEvent,
  resolveChannel?: (name: string) => string | null,
): boolean {
  if (filter.channels) {
    if (evt.channel === null) return false
    const evtCanonical = (resolveChannel?.(evt.channel) ?? evt.channel).toLowerCase()
    const hit = filter.channels.some(
      c => (resolveChannel?.(c) ?? c).toLowerCase() === evtCanonical,
    )
    if (!hit) return false
  }
  if (filter.types && !filter.types.includes(evt.type)) return false
  if (filter.agents && !filter.agents.includes(evt.agent)) return false
  if (filter.tagsAny && !filter.tagsAny.some(t => evt.tags.includes(t))) return false
  if (filter.textIncludes) {
    const body = evt.body.toLowerCase()
    if (!filter.textIncludes.some(t => body.includes(t.toLowerCase()))) return false
  }
  return true
}
