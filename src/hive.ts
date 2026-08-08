/**
 * The Hive manages swarms as durable things: each swarm is a sqlite event log
 * on disk plus a metadata record. Create runs a new swarm; archive retires it
 * (read-only, kept); delete removes it. Finished and archived swarms stay
 * inspectable — the log is the artifact.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openSwarmForInspection } from './core/runtime.js'
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
  /** Read-only inspection views over finished/previous-process swarm logs. */
  private readonly views = new Map<string, Swarm>()
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
   * The Swarm instance for a hive entry — the live one when it's running or was
   * created in this process, else a read-only inspection view opened over its
   * database with the roster reconstructed from the log. Inspection views never
   * run createSwarm (which would re-spawn agents into a finished swarm's log).
   */
  swarm(id: string): Swarm | null {
    if (!this.records.has(id)) return null
    const live = this.live.get(id)
    if (live !== undefined) return live
    let view = this.views.get(id)
    if (view === undefined) {
      view = openSwarmForInspection(this.dbPath(id))
      this.views.set(id, view)
    }
    return view
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

  /** Stop a running swarm for good — the explicit terminate, cap-independent. */
  stop(id: string): SwarmRecord {
    const record = this.mustGet(id)
    const s = this.live.get(id)
    if (s !== undefined && this.runs.has(id)) s.stop()
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
    // Close any open handle (live run or inspection view) before removing the db.
    for (const cache of [this.live, this.views]) {
      const s = cache.get(id)
      if (s !== undefined) {
        try {
          s.log.close()
        } catch {
          // already closed
        }
        cache.delete(id)
      }
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
