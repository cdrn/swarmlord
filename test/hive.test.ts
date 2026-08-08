import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hive } from '../src/hive.js'
import { Swarm } from '../src/core/runtime.js'
import { MockAdapter, turnOf } from '../src/adapters/mock.js'

// Factory for hives whose swarms complete on their first turn.
function completingSwarm(dbPath: string): Swarm {
  const adapter = new MockAdapter(() => turnOf([{ name: 'complete', input: { summary: 'done' } }]))
  return new Swarm({ adapter, dbPath, maxTotalTurns: 10 })
}

// Factory for hives whose swarms never complete: create a channel, then post
// to it forever. Only stop() (or the turn cap) ends these.
function spinningSwarm(dbPath: string): Swarm {
  let n = 0
  const adapter = new MockAdapter(() => {
    n++
    if (n === 1) {
      return turnOf([{ name: 'create_channel', input: { name: 'work', purpose: 'busywork' } }])
    }
    return turnOf([{ name: 'post', input: { channel: 'work', body: `busy turn ${n}` } }])
  })
  return new Swarm({ adapter, dbPath, maxTotalTurns: 1000 })
}

describe('Hive', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmlord-hive-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('create() starts a run and settles into a finished record on disk', async () => {
    const hive = new Hive({ dir, createSwarm: completingSwarm })

    const rec = hive.create('First Flight', 'do the thing')
    expect(rec.running).toBe(true)
    expect(rec.status).toBe('active')
    expect(rec.task).toBe('do the thing')

    await hive.settled(rec.id)

    const after = hive.list().find(r => r.id === rec.id)
    expect(after).toBeDefined()
    expect(after!.running).toBe(false)
    expect(after!.error).toBeNull()
    expect(after!.result).not.toBeNull()
    expect(after!.result!.turns).toBeGreaterThan(0)
    expect(after!.result!.agents).toBeGreaterThan(0)
    expect(after!.result!.events).toBeGreaterThan(0)

    expect(existsSync(join(dir, 'hive.json'))).toBe(true)
    expect(existsSync(join(dir, `${rec.id}.db`))).toBe(true)
  })

  it('a second Hive over the same dir loads persisted records', async () => {
    const hive = new Hive({ dir, createSwarm: completingSwarm })
    const rec = hive.create('Persist Me', 'remember this')
    await hive.settled(rec.id)

    const hive2 = new Hive({ dir, createSwarm: completingSwarm })
    const loaded = hive2.get(rec.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.title).toBe('Persist Me')
    expect(loaded!.task).toBe('remember this')
    expect(loaded!.running).toBe(false)
    expect(loaded!.result).not.toBeNull()
    expect(hive2.list().map(r => r.id)).toContain(rec.id)
  })

  it('archive() refuses while running, works after stop, and unarchive() reverts', async () => {
    const hive = new Hive({ dir, createSwarm: spinningSwarm })
    const rec = hive.create('Spinner', 'spin forever')
    expect(rec.running).toBe(true)

    expect(() => hive.archive(rec.id)).toThrow(/running/)

    const stopped = hive.stop(rec.id)
    expect(stopped.id).toBe(rec.id)
    await hive.settled(rec.id)

    const archived = hive.archive(rec.id)
    expect(archived.status).toBe('archived')
    expect(archived.running).toBe(false)
    expect(hive.get(rec.id)!.status).toBe('archived')

    const restored = hive.unarchive(rec.id)
    expect(restored.status).toBe('active')
    expect(hive.get(rec.id)!.status).toBe('active')
  })

  it('delete() refuses while running, then removes the record and db file', async () => {
    const hive = new Hive({ dir, createSwarm: spinningSwarm })
    const rec = hive.create('Doomed', 'spin then die')
    expect(() => hive.delete(rec.id)).toThrow(/running/)

    hive.stop(rec.id)
    await hive.settled(rec.id)

    const dbPath = join(dir, `${rec.id}.db`)
    expect(existsSync(dbPath)).toBe(true)

    hive.delete(rec.id)
    expect(hive.get(rec.id)).toBeNull()
    expect(hive.list()).toHaveLength(0)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('operations on unknown ids throw the known-ids message', () => {
    const hive = new Hive({ dir, createSwarm: completingSwarm })
    for (const op of [
      () => hive.stop('nope'),
      () => hive.archive('nope'),
      () => hive.unarchive('nope'),
      () => hive.delete('nope'),
    ]) {
      expect(op).toThrow(/no swarm "nope" — known:/)
    }
    expect(hive.get('nope')).toBeNull()
    expect(hive.swarm('nope')).toBeNull()
  })

  it('swarm(id) on a finished record reopens a view over the run events', async () => {
    const hive = new Hive({ dir, createSwarm: completingSwarm })
    const rec = hive.create('Reopen', 'leave a trail')
    await hive.settled(rec.id)

    // A fresh Hive has no live instance — swarm(id) must open the db lazily.
    const hive2 = new Hive({ dir, createSwarm: completingSwarm })
    const view = hive2.swarm(rec.id)
    expect(view).not.toBeNull()

    const events = view!.log.query()
    expect(events.length).toBeGreaterThan(0)
    expect(events.some(e => e.type === 'agent_done')).toBe(true)
  })

  it('reconstructs the roster from the log on reopen without mutating the log', async () => {
    // A swarm that spawns a worker, then both complete — leaves a real roster.
    const spawningSwarm = (dbPath: string): Swarm => {
      let n = 0
      const adapter = new MockAdapter(req => {
        const who = /Your name is "([^"]+)"/.exec(req.system)?.[1] ?? '?'
        if (who === 'overseer') {
          n++
          if (n === 1) {
            return turnOf([{ name: 'spawn', input: { name: 'scout', role: 'scout', prompt: 'look' } }])
          }
          return turnOf([{ name: 'complete', input: { summary: 'overseer done' } }])
        }
        return turnOf([{ name: 'complete', input: { summary: 'scout done' } }])
      })
      return new Swarm({ adapter, dbPath, maxTotalTurns: 20 })
    }

    const hive = new Hive({ dir, createSwarm: spawningSwarm })
    const rec = hive.create('Roster', 'spawn a scout and finish')
    await hive.settled(rec.id)

    const hive2 = new Hive({ dir, createSwarm: spawningSwarm })
    const view = hive2.swarm(rec.id)!
    const eventsBefore = view.log.lastId()

    // Roster is reconstructed from the log, with roles/lineage/terminal status.
    const roster = view.snapshot().agents
    const names = roster.map(a => a.name)
    expect(names).toContain('overseer')
    expect(names).toContain('scout')
    const scout = roster.find(a => a.name === 'scout')!
    expect(scout.parent).toBe('overseer')
    expect(scout.role).toBe('scout')
    expect(scout.status).toBe('done')

    // Reopening/inspecting must NOT append anything to the persisted log
    // (the old bug re-spawned the librarian into finished swarms).
    expect(view.log.lastId()).toBe(eventsBefore)
    expect(view.snapshot().agents.length).toBe(roster.length)
  })
})
