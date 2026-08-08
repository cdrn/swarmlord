/**
 * The Hive manages swarms as durable things: each swarm is a sqlite event log
 * on disk plus a metadata record. Create runs a new swarm; archive retires it
 * (read-only, kept); delete removes it. Finished and archived swarms stay
 * inspectable — the log is the artifact.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Swarm, SwarmResult } from './core/runtime.js'

export interface SwarmRecord {
  id: string
  title: string
  task: string | null
  status: 'active' | 'archived'
  createdAt: number
  /** Live in this process right now. */
  running: boolean
  result: { turns: number; agents: number; events: number } | null
  error: string | null
}

export interface HiveOptions {
  /** Directory for swarm databases and the hive index. */
  dir: string
  /** Factory building a fully-configured Swarm over a given db path. */
  createSwarm: (dbPath: string) => Swarm
}

type StoredRecord = Omit<SwarmRecord, 'running'>

export class Hive {
  private readonly dir: string
  private readonly createSwarm: (dbPath: string) => Swarm
  private readonly records = new Map<string, StoredRecord>()
  private readonly live = new Map<string, Swarm>()
  private readonly runs = new Map<string, Promise<void>>()

  constructor(opts: HiveOptions) {
    this.dir = opts.dir
    this.createSwarm = opts.createSwarm
    mkdirSync(this.dir, { recursive: true })
    const indexPath = this.indexPath()
    if (existsSync(indexPath)) {
      const stored = JSON.parse(readFileSync(indexPath, 'utf8')) as StoredRecord[]
      for (const r of stored) this.records.set(r.id, r)
    }
  }

  list(): SwarmRecord[] {
    return [...this.records.values()]
      .map(r => ({ ...r, running: this.runs.has(r.id) }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): SwarmRecord | null {
    const r = this.records.get(id)
    return r ? { ...r, running: this.runs.has(id) } : null
  }

  /**
   * The Swarm instance for a hive entry — the live one when running, else a
   * lazily-opened view over its database (board and log readable; the
   * in-memory agent roster of past runs is gone, the events are not).
   */
  swarm(id: string): Swarm | null {
    if (!this.records.has(id)) return null
    let s = this.live.get(id)
    if (s === undefined) {
      s = this.createSwarm(this.dbPath(id))
      this.live.set(id, s)
    }
    return s
  }

  /** Create a swarm and start it on the task. Returns immediately. */
  create(title: string, task: string): SwarmRecord {
    const id = this.newId(title)
    const record: StoredRecord = {
      id,
      title: title.trim() === '' ? id : title.trim(),
      task,
      status: 'active',
      createdAt: Date.now(),
      result: null,
      error: null,
    }
    this.records.set(id, record)
    this.save()

    const swarm = this.createSwarm(this.dbPath(id))
    this.live.set(id, swarm)
    const run = swarm
      .run(task)
      .then((result: SwarmResult) => {
        record.result = { turns: result.turns, agents: result.agents.length, events: result.events }
      })
      .catch((e: unknown) => {
        record.error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        this.runs.delete(id)
        this.save()
      })
    this.runs.set(id, run)
    return { ...record, running: true }
  }

  /** Soft-stop a running swarm: zero the turn cap, let the loop wind down. */
  stop(id: string): SwarmRecord {
    const record = this.mustGet(id)
    const s = this.live.get(id)
    if (s !== undefined && this.runs.has(id)) {
      s.configure({ maxTotalTurns: 0, paused: false })
    }
    return { ...record, running: this.runs.has(id) }
  }

  archive(id: string): SwarmRecord {
    const record = this.mustGet(id)
    if (this.runs.has(id)) throw new Error(`swarm "${id}" is running — stop it before archiving`)
    record.status = 'archived'
    this.save()
    return { ...record, running: false }
  }

  unarchive(id: string): SwarmRecord {
    const record = this.mustGet(id)
    record.status = 'active'
    this.save()
    return { ...record, running: false }
  }

  /** Removes the record AND the database. Refuses while running. */
  delete(id: string): void {
    const record = this.mustGet(id)
    if (this.runs.has(id)) throw new Error(`swarm "${id}" is running — stop it before deleting`)
    const s = this.live.get(id)
    if (s !== undefined) {
      try {
        s.log.close()
      } catch {
        // already closed
      }
      this.live.delete(id)
    }
    this.records.delete(record.id)
    rmSync(this.dbPath(id), { force: true })
    this.save()
  }

  /** Resolves when a given swarm's run (if any) settles. Mostly for tests. */
  settled(id: string): Promise<void> {
    return this.runs.get(id) ?? Promise.resolve()
  }

  private mustGet(id: string): StoredRecord {
    const r = this.records.get(id)
    if (r === undefined) {
      throw new Error(`no swarm "${id}" — known: ${[...this.records.keys()].join(', ') || '(none)'}`)
    }
    return r
  }

  private newId(title: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'swarm'
    let id = slug
    let n = 2
    while (this.records.has(id) || existsSync(this.dbPath(id))) id = `${slug}-${n++}`
    return id
  }

  private dbPath(id: string): string {
    return join(this.dir, `${id}.db`)
  }

  private indexPath(): string {
    return join(this.dir, 'hive.json')
  }

  private save(): void {
    writeFileSync(this.indexPath(), JSON.stringify([...this.records.values()], null, 2))
  }
}
