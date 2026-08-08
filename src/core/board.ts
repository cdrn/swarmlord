import type { ChannelInfo, ChannelManifest, SwarmEvent } from './events.js'
import type { EventLog } from './log.js'

export interface BoardOptions {
  pinSlots?: number
  claimTtlMs?: number
}

export type CreateChannelResult =
  | { created: true; channel: ChannelInfo; event: SwarmEvent }
  /** Exact name collision (including alias names); `force` can never override. */
  | { created: false; reason: 'name_taken'; existing: ChannelInfo; similar?: never }
  /** Write-through search hit; re-assert with `force` to create anyway. */
  | { created: false; reason: 'similar'; similar: ChannelInfo[] }

export interface PostResult {
  event: SwarmEvent
  duplicateOf: SwarmEvent | null
}

export interface ClaimResult {
  granted: boolean
  holders: string[]
  event: SwarmEvent | null
  error?: string
}

interface ChannelRow {
  name: string
  purpose: string
  tags: string
  created_by: string
  created_at: number
  alias_of: string | null
}

const SIMILARITY_THRESHOLD = 0.3

function tokenSet(manifest: ChannelManifest): Set<string> {
  const text = [manifest.name, manifest.purpose, ...manifest.tags].join(' ')
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

function excerpt(body: string, max = 80): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export class Blackboard {
  private readonly log: EventLog
  /** Mutable: the runtime's configure() can retune these live. */
  pinSlots: number
  claimTtlMs: number

  constructor(log: EventLog, opts: BoardOptions = {}) {
    this.log = log
    this.pinSlots = opts.pinSlots ?? 3
    this.claimTtlMs = opts.claimTtlMs ?? 300_000
    log.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        purpose TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        alias_of TEXT
      );
      CREATE TABLE IF NOT EXISTS claims (
        task_event_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_event_id, agent)
      );
      CREATE TABLE IF NOT EXISTS pins (
        agent TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (agent, event_id)
      );
    `)
  }

  createChannel(agent: string, manifest: ChannelManifest, force = false): CreateChannelResult {
    // Exact name collisions (including alias names) can never be forced past —
    // the name is taken. Report the canonical channel the name resolves to.
    const existing = this.getRow(manifest.name)
    if (existing !== null) {
      const canonical = this.resolve(manifest.name) ?? existing.name
      const canonicalRow = this.getRow(canonical) ?? existing
      return { created: false, reason: 'name_taken', existing: this.rowToInfo(canonicalRow) }
    }

    // `force` bypasses only the similarity search, never a name collision.
    if (!force) {
      const similar = this.findSimilar(manifest)
      if (similar.length > 0) return { created: false, reason: 'similar', similar }
    }

    const createdAt = Date.now()
    this.log.db
      .prepare(
        `INSERT INTO channels (name, purpose, tags, created_by, created_at, alias_of)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(manifest.name, manifest.purpose, JSON.stringify(manifest.tags), agent, createdAt)

    const event = this.log.append({
      type: 'channel_created',
      agent,
      channel: manifest.name,
      body: `Created channel "${manifest.name}": ${manifest.purpose}`,
      tags: [...manifest.tags],
      refs: [],
      meta: { manifest, force },
    })

    const row = this.getRow(manifest.name)
    if (row === null) throw new Error(`channel insert failed: ${manifest.name}`)
    return { created: true, channel: this.rowToInfo(row), event }
  }

  resolve(name: string): string | null {
    const seen = new Set<string>()
    let current = name
    for (;;) {
      const row = this.getRow(current)
      if (row === null) return null
      if (row.alias_of === null) return row.name
      if (seen.has(row.name.toLowerCase())) return row.name // defensive: broken cycle
      seen.add(row.name.toLowerCase())
      current = row.alias_of
    }
  }

  /**
   * All stored channel names that resolve to the same canonical channel as
   * `name` (the canonical name itself plus every alias), in stored casing.
   * Null if the name is unknown.
   */
  channelFamily(name: string): string[] | null {
    const canonical = this.resolve(name)
    return canonical === null ? null : this.namesResolvingTo(canonical)
  }

  catalog(): ChannelInfo[] {
    const rows = this.log.db
      .prepare('SELECT * FROM channels WHERE alias_of IS NULL ORDER BY created_at ASC, name ASC')
      .all() as unknown as ChannelRow[]
    return rows.map(r => this.rowToInfo(r))
  }

  post(
    agent: string,
    channel: string,
    body: string,
    opts?: { tags?: string[]; refs?: number[] },
  ): PostResult {
    const canonical = this.resolve(channel)
    if (canonical === null) throw new Error(`unknown channel: ${channel}`)
    const event = this.log.append({
      type: 'post',
      agent,
      channel: canonical,
      body,
      tags: opts?.tags ?? [],
      refs: opts?.refs ?? [],
      meta: {},
    })
    const duplicateOf = event.duplicateOf === null ? null : this.log.get(event.duplicateOf)
    return { event, duplicateOf }
  }

  pin(agent: string, eventId: number): { pinned: boolean; error?: string; pins: number[] } {
    const target = this.log.get(eventId)
    if (target === null) {
      return { pinned: false, error: `unknown event #${eventId}`, pins: this.pinsFor(agent) }
    }
    const current = this.pinsFor(agent)
    if (current.includes(eventId)) {
      return { pinned: true, pins: current }
    }
    if (current.length >= this.pinSlots) {
      return {
        pinned: false,
        error: `pin slots full (${current.length}/${this.pinSlots}); current pins: ${current.map(id => `#${id}`).join(', ')} — unpin one first`,
        pins: current,
      }
    }
    this.log.db
      .prepare('INSERT INTO pins (agent, event_id, pinned_at) VALUES (?, ?, ?)')
      .run(agent, eventId, Date.now())
    this.log.append({
      type: 'pinned',
      agent,
      channel: target.channel,
      body: `Pinned event #${eventId}: "${excerpt(target.body)}"`,
      tags: [],
      refs: [eventId],
      meta: { eventId },
    })
    return { pinned: true, pins: this.pinsFor(agent) }
  }

  unpin(agent: string, eventId: number): void {
    const result = this.log.db
      .prepare('DELETE FROM pins WHERE agent = ? AND event_id = ?')
      .run(agent, eventId)
    if (Number(result.changes) === 0) return
    const target = this.log.get(eventId)
    this.log.append({
      type: 'unpinned',
      agent,
      channel: target?.channel ?? null,
      body: `Unpinned event #${eventId}`,
      tags: [],
      refs: [eventId],
      meta: { eventId },
    })
  }

  pins(): Array<{ eventId: number; agent: string }> {
    const rows = this.log.db
      .prepare('SELECT agent, event_id FROM pins ORDER BY pinned_at ASC, event_id ASC')
      .all() as unknown as Array<{ agent: string; event_id: number }>
    return rows.map(r => ({ eventId: r.event_id, agent: r.agent }))
  }

  claim(agent: string, taskEventId: number, join = false): ClaimResult {
    // A claim on a nonexistent event would be a phantom with dangling refs.
    if (this.log.get(taskEventId) === null) {
      return { granted: false, holders: [], event: null, error: `unknown event #${taskEventId}` }
    }

    const holders = this.activeClaims(taskEventId)
    const alreadyHolds = holders.includes(agent)
    const others = holders.filter(h => h !== agent)

    // Informed refusal: someone else holds it and the claimant didn't join.
    if (!alreadyHolds && others.length > 0 && !join) {
      return { granted: false, holders: others, event: null }
    }

    const expiresAt = Date.now() + this.claimTtlMs
    this.log.db
      .prepare(
        `INSERT INTO claims (task_event_id, agent, expires_at, released) VALUES (?, ?, ?, 0)
         ON CONFLICT(task_event_id, agent) DO UPDATE SET expires_at = excluded.expires_at, released = 0`,
      )
      .run(taskEventId, agent, expiresAt)

    const body = alreadyHolds
      ? `Renewed claim on event #${taskEventId}`
      : others.length > 0
        ? `Joined claim on event #${taskEventId} (also held by ${others.join(', ')})`
        : `Claimed event #${taskEventId}`
    const event = this.log.append({
      type: 'claimed',
      agent,
      channel: null,
      body,
      tags: [],
      refs: [taskEventId],
      meta: {
        taskEventId,
        join: !alreadyHolds && others.length > 0,
        renewed: alreadyHolds,
        expiresAt,
        holders: alreadyHolds ? holders : [...others, agent],
      },
    })
    return { granted: true, holders: alreadyHolds ? holders : [...others, agent], event }
  }

  release(agent: string, taskEventId: number): void {
    const result = this.log.db
      .prepare('UPDATE claims SET released = 1 WHERE task_event_id = ? AND agent = ? AND released = 0')
      .run(taskEventId, agent)
    if (Number(result.changes) === 0) return
    this.log.append({
      type: 'claim_released',
      agent,
      channel: null,
      body: `Released claim on event #${taskEventId}`,
      tags: [],
      refs: [taskEventId],
      meta: { taskEventId },
    })
  }

  activeClaims(taskEventId: number): string[] {
    const rows = this.log.db
      .prepare(
        'SELECT agent FROM claims WHERE task_event_id = ? AND released = 0 AND expires_at > ? ORDER BY rowid ASC',
      )
      .all(taskEventId, Date.now()) as unknown as Array<{ agent: string }>
    return rows.map(r => r.agent)
  }

  merge(agent: string, from: string, to: string): SwarmEvent {
    const canonicalFrom = this.resolve(from)
    const canonicalTo = this.resolve(to)
    if (canonicalFrom === null) throw new Error(`unknown channel: ${from}`)
    if (canonicalTo === null) throw new Error(`unknown channel: ${to}`)
    if (canonicalFrom.toLowerCase() === canonicalTo.toLowerCase()) {
      throw new Error(`cannot merge "${from}" into "${to}": same canonical channel ("${canonicalFrom}")`)
    }

    // Aliasing the canonical of `from` redirects its whole chain; pointing at
    // the canonical of `to` plus the same-canonical check above rules out cycles.
    this.log.db
      .prepare('UPDATE channels SET alias_of = ? WHERE name = ?')
      .run(canonicalTo, canonicalFrom)

    return this.log.append({
      type: 'channel_merged',
      agent,
      channel: canonicalTo,
      body: `Merged channel "${canonicalFrom}" into "${canonicalTo}"`,
      tags: [],
      refs: [],
      meta: { from: canonicalFrom, to: canonicalTo },
    })
  }

  private getRow(name: string): ChannelRow | null {
    const row = this.log.db.prepare('SELECT * FROM channels WHERE name = ?').get(name) as
      | ChannelRow
      | undefined
    return row ?? null
  }

  private findSimilar(manifest: ChannelManifest): ChannelInfo[] {
    const candidate = tokenSet(manifest)
    const candidateName = manifest.name.toLowerCase()
    const rows = this.log.db.prepare('SELECT * FROM channels').all() as unknown as ChannelRow[]
    const similar: ChannelInfo[] = []
    for (const row of rows) {
      const rowName = row.name.toLowerCase()
      const nameHit = rowName.includes(candidateName) || candidateName.includes(rowName)
      const existing = tokenSet({
        name: row.name,
        purpose: row.purpose,
        tags: JSON.parse(row.tags) as string[],
      })
      if (nameHit || jaccard(candidate, existing) >= SIMILARITY_THRESHOLD) {
        similar.push(this.rowToInfo(row))
      }
    }
    return similar
  }

  private rowToInfo(row: ChannelRow): ChannelInfo {
    // Stats cover every name that resolves to this channel, so posts made
    // under pre-merge names still count.
    const names = row.alias_of === null ? this.namesResolvingTo(row.name) : [row.name]
    const placeholders = names.map(() => '?').join(', ')
    const stats = this.log.db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(ts) AS last FROM events WHERE type = 'post' AND channel IN (${placeholders})`,
      )
      .get(...names) as { count: number; last: number | null }
    return {
      name: row.name,
      purpose: row.purpose,
      tags: JSON.parse(row.tags) as string[],
      createdBy: row.created_by,
      createdAt: row.created_at,
      aliasOf: row.alias_of === null ? null : this.resolve(row.alias_of),
      eventCount: stats.count,
      lastEventAt: stats.last,
    }
  }

  private namesResolvingTo(canonical: string): string[] {
    const rows = this.log.db.prepare('SELECT name FROM channels').all() as unknown as Array<{
      name: string
    }>
    const lower = canonical.toLowerCase()
    return rows.map(r => r.name).filter(n => (this.resolve(n) ?? '').toLowerCase() === lower)
  }

  private pinsFor(agent: string): number[] {
    const rows = this.log.db
      .prepare('SELECT event_id FROM pins WHERE agent = ? ORDER BY pinned_at ASC, event_id ASC')
      .all(agent) as unknown as Array<{ event_id: number }>
    return rows.map(r => r.event_id)
  }
}
