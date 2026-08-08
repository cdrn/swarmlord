import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { EventFilter, EventType, NewEvent, SwarmEvent } from './events.js'

interface EventRow {
  id: number
  ts: number
  type: string
  agent: string
  channel: string | null
  body: string
  tags: string
  refs: string
  meta: string
  content_hash: string | null
  duplicate_of: number | null
}

function rowToEvent(row: EventRow): SwarmEvent {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type as EventType,
    agent: row.agent,
    channel: row.channel,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    refs: JSON.parse(row.refs) as number[],
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    duplicateOf: row.duplicate_of,
  }
}

function contentHash(body: string): string {
  const normalized = body.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex')
}

export class EventLog {
  readonly db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        channel TEXT,
        body TEXT NOT NULL,
        tags TEXT NOT NULL,
        refs TEXT NOT NULL,
        meta TEXT NOT NULL,
        content_hash TEXT,
        duplicate_of INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_content_hash ON events(content_hash);
      CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel);
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, tags);
    `)
  }

  append(evt: NewEvent): SwarmEvent {
    const ts = evt.ts ?? Date.now()
    let hash: string | null = null
    let duplicateOf: number | null = null
    if (evt.type === 'post') {
      hash = contentHash(evt.body)
      const earliest = this.db
        .prepare('SELECT id FROM events WHERE content_hash = ? ORDER BY id ASC LIMIT 1')
        .get(hash) as { id: number } | undefined
      if (earliest !== undefined) duplicateOf = earliest.id
    }
    const result = this.db
      .prepare(
        `INSERT INTO events (ts, type, agent, channel, body, tags, refs, meta, content_hash, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        evt.type,
        evt.agent,
        evt.channel,
        evt.body,
        JSON.stringify(evt.tags),
        JSON.stringify(evt.refs),
        JSON.stringify(evt.meta),
        hash,
        duplicateOf,
      )
    const id = Number(result.lastInsertRowid)
    // Standalone FTS table: rowid mirrors events.id, maintained manually.
    this.db
      .prepare('INSERT INTO events_fts (rowid, body, tags) VALUES (?, ?, ?)')
      .run(id, evt.body, evt.tags.join(' '))
    return {
      id,
      ts,
      type: evt.type,
      agent: evt.agent,
      channel: evt.channel,
      body: evt.body,
      tags: [...evt.tags],
      refs: [...evt.refs],
      meta: { ...evt.meta },
      duplicateOf,
    }
  }

  get(id: number): SwarmEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as
      | EventRow
      | undefined
    return row === undefined ? null : rowToEvent(row)
  }

  query(filter: EventFilter = {}): SwarmEvent[] {
    // Explicitly-empty list filters can match nothing; mirror matchesFilter.
    if (filter.types !== undefined && filter.types.length === 0) return []
    if (filter.tagsAny !== undefined && filter.tagsAny.length === 0) return []
    if (filter.channels !== undefined && filter.channels.length === 0) return []

    const where: string[] = []
    const params: Array<string | number> = []
    let join = ''

    if (filter.text !== undefined) {
      // Unicode-aware: \w is ASCII-only and would drop e.g. Cyrillic/CJK terms.
      const tokens = filter.text.match(/[\p{L}\p{N}_]+/gu) ?? []
      // An explicit text filter with no searchable tokens can match nothing;
      // mirrors the empty types/tagsAny handling above.
      if (tokens.length === 0) return []
      join = ' JOIN events_fts ON events_fts.rowid = e.id'
      where.push('events_fts MATCH ?')
      params.push(tokens.map(t => `"${t}"`).join(' OR '))
    }
    // `channel` is sugar for a one-element `channels`; both match NOCASE so the
    // events table agrees with the NOCASE-keyed channels table.
    const channels =
      filter.channels ?? (filter.channel !== undefined ? [filter.channel] : undefined)
    if (channels !== undefined) {
      where.push(`e.channel COLLATE NOCASE IN (${channels.map(() => '?').join(', ')})`)
      params.push(...channels)
    }
    if (filter.types !== undefined) {
      where.push(`e.type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types)
    }
    if (filter.agent !== undefined) {
      where.push('e.agent = ?')
      params.push(filter.agent)
    }
    if (filter.tagsAny !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value IN (${filter.tagsAny.map(() => '?').join(', ')}))`,
      )
      params.push(...filter.tagsAny)
    }
    if (filter.sinceId !== undefined) {
      where.push('e.id > ?')
      params.push(filter.sinceId)
    }

    const sql =
      `SELECT e.* FROM events e${join}` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY e.id ASC LIMIT ?'
    params.push(filter.limit ?? 50)
    const rows = this.db.prepare(sql).all(...params) as unknown as EventRow[]
    return rows.map(rowToEvent)
  }

  lastId(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS last FROM events')
      .get() as { last: number }
    return row.last
  }

  close(): void {
    this.db.close()
  }
}
