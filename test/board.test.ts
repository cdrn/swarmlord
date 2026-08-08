import { describe, it, expect } from 'vitest'
import { EventLog } from '../src/core/log.js'
import { Blackboard } from '../src/core/board.js'
import type { ChannelManifest } from '../src/core/events.js'

function fresh(opts?: { pinSlots?: number; claimTtlMs?: number }) {
  const log = new EventLog()
  const board = new Blackboard(log, opts)
  return { log, board }
}

const sourcesManifest: ChannelManifest = {
  name: 'sources',
  purpose: 'candidate reading sources and links for the research task',
  tags: ['research', 'links'],
}

describe('Blackboard', () => {
  it('create_channel does write-through search; force overrides', () => {
    const { board } = fresh()

    const r1 = board.createChannel('a', sourcesManifest)
    expect(r1.created).toBe(true)
    if (!r1.created) throw new Error('unreachable')
    expect(r1.channel.name).toBe('sources')
    expect(r1.event.type).toBe('channel_created')

    const overlapping: ChannelManifest = {
      name: 'source-list',
      purpose: 'candidate reading sources and links for the research task',
      tags: ['research', 'links'],
    }
    const r2 = board.createChannel('b', overlapping)
    expect(r2.created).toBe(false)
    if (r2.created) throw new Error('unreachable')
    expect(r2.reason).toBe('similar')
    if (r2.reason !== 'similar') throw new Error('unreachable')
    expect(r2.similar.map(c => c.name)).toContain('sources')

    const r3 = board.createChannel('b', overlapping, true)
    expect(r3.created).toBe(true)
    if (!r3.created) throw new Error('unreachable')
    expect(r3.channel.name).toBe('source-list')
  })

  it('exact name collisions are name_taken and cannot be forced', () => {
    const { board } = fresh()
    board.createChannel('a', sourcesManifest)

    const dupe = board.createChannel('b', {
      name: 'sources',
      purpose: 'a wholly unrelated purpose with zero token overlap',
      tags: [],
    })
    expect(dupe.created).toBe(false)
    if (dupe.created) throw new Error('unreachable')
    expect(dupe.reason).toBe('name_taken')
    if (dupe.reason !== 'name_taken') throw new Error('unreachable')
    expect(dupe.existing.name).toBe('sources')

    // force bypasses only the similarity search, never a taken name
    const forced = board.createChannel('b', { name: 'SOURCES', purpose: 'x y z', tags: [] }, true)
    expect(forced.created).toBe(false)
    if (forced.created) throw new Error('unreachable')
    expect(forced.reason).toBe('name_taken')

    // an alias name is also taken; the canonical channel's info comes back
    board.createChannel('a', { name: 'source-list', purpose: 'links to read', tags: ['links'] }, true)
    board.merge('a', 'source-list', 'sources')
    const viaAlias = board.createChannel('b', { name: 'source-list', purpose: 'q r s', tags: [] }, true)
    expect(viaAlias.created).toBe(false)
    if (viaAlias.created) throw new Error('unreachable')
    expect(viaAlias.reason).toBe('name_taken')
    if (viaAlias.reason !== 'name_taken') throw new Error('unreachable')
    expect(viaAlias.existing.name).toBe('sources')
  })

  it('links exact-dupe posts instead of blocking them', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'findings', purpose: 'research findings', tags: ['findings'] })

    const body = 'The cache invalidation bug lives in ttl handling'
    const p1 = board.post('a', 'findings', body)
    const p2 = board.post('b', 'findings', body)

    expect(p1.duplicateOf).toBeNull()
    expect(p2.duplicateOf).not.toBeNull()
    expect(p2.duplicateOf!.id).toBe(p1.event.id)
    expect(p2.event.duplicateOf).toBe(p1.event.id)

    // both events are recorded — convergence is signal, not noise
    expect(log.get(p1.event.id)).not.toBeNull()
    expect(log.get(p2.event.id)).not.toBeNull()
    const posts = log.query({ types: ['post'], channel: 'findings' })
    expect(posts.map(e => e.id)).toEqual([p1.event.id, p2.event.id])
  })

  it('claims are informed: second claimant must consciously join', () => {
    const { board } = fresh()
    board.createChannel('a', { name: 'tasks', purpose: 'open work items', tags: ['tasks'] })
    const task = board.post('a', 'tasks', 'audit the login flow', { tags: ['task'] }).event

    const r1 = board.claim('a', task.id)
    expect(r1.granted).toBe(true)
    expect(r1.holders).toContain('a')
    expect(r1.event).not.toBeNull()
    expect(r1.event!.type).toBe('claimed')

    const r2 = board.claim('b', task.id)
    expect(r2.granted).toBe(false)
    expect(r2.holders).toEqual(['a'])

    const r3 = board.claim('b', task.id, true)
    expect(r3.granted).toBe(true)
    expect(board.activeClaims(task.id).sort()).toEqual(['a', 'b'])

    board.release('a', task.id)
    expect(board.activeClaims(task.id)).toEqual(['b'])
  })

  it('claim on a nonexistent event is refused with an error and appends nothing', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'tasks', purpose: 'open work items', tags: ['tasks'] })
    const before = log.lastId()

    const r = board.claim('a', 99999)
    expect(r.granted).toBe(false)
    expect(r.holders).toEqual([])
    expect(r.event).toBeNull()
    expect(r.error).toBe('unknown event #99999')
    expect(log.lastId()).toBe(before)
    expect(board.activeClaims(99999)).toEqual([])
  })

  it('claims expire after claimTtlMs, freeing the task', async () => {
    const { board } = fresh({ claimTtlMs: 10 })
    board.createChannel('a', { name: 'tasks', purpose: 'open work items', tags: ['tasks'] })
    const task = board.post('a', 'tasks', 'summarize the design doc', { tags: ['task'] }).event

    expect(board.claim('a', task.id).granted).toBe(true)
    expect(board.activeClaims(task.id)).toEqual(['a'])

    await new Promise(resolve => setTimeout(resolve, 25))

    expect(board.activeClaims(task.id)).toEqual([])
    const r = board.claim('b', task.id)
    expect(r.granted).toBe(true)
    expect(board.activeClaims(task.id)).toEqual(['b'])
  })

  it('merge aliases a channel; posts land canonical and resolve follows the chain', () => {
    const { board } = fresh()
    board.createChannel('a', sourcesManifest)
    board.createChannel('a', { name: 'source-list', purpose: 'links to read', tags: ['links'] }, true)
    board.createChannel('a', { name: 'source-catalog', purpose: 'catalog of links', tags: ['links'] }, true)

    board.merge('a', 'source-catalog', 'source-list')
    const mergeEvt = board.merge('a', 'source-list', 'sources')
    expect(mergeEvt.type).toBe('channel_merged')

    const p = board.post('b', 'source-list', 'found a great paper on swarm coordination')
    expect(p.event.channel).toBe('sources')

    expect(board.resolve('sources')).toBe('sources')
    expect(board.resolve('source-list')).toBe('sources')
    expect(board.resolve('source-catalog')).toBe('sources')
    expect(board.resolve('no-such-channel')).toBeNull()

    // catalog lists canonical channels only
    const names = board.catalog().map(c => c.name)
    expect(names).toContain('sources')
    expect(names).not.toContain('source-list')
    expect(names).not.toContain('source-catalog')
  })

  it('channelFamily returns every name resolving to the canonical channel', () => {
    const { board } = fresh()
    board.createChannel('a', sourcesManifest)
    board.createChannel('a', { name: 'source-list', purpose: 'links to read', tags: ['links'] }, true)
    board.createChannel('a', { name: 'source-catalog', purpose: 'catalog of links', tags: ['links'] }, true)

    board.merge('a', 'source-catalog', 'source-list')
    board.merge('a', 'source-list', 'sources')

    const family = ['source-catalog', 'source-list', 'sources']
    expect(board.channelFamily('sources')!.sort()).toEqual(family)
    expect(board.channelFamily('source-catalog')!.sort()).toEqual(family)
    expect(board.channelFamily('no-such-channel')).toBeNull()
  })

  it('pins are limited slots; a full slot returns current pins', () => {
    const { board } = fresh({ pinSlots: 2 })
    board.createChannel('a', { name: 'notes', purpose: 'scratch notes', tags: ['notes'] })
    const e1 = board.post('a', 'notes', 'first important note').event
    const e2 = board.post('a', 'notes', 'second important note').event
    const e3 = board.post('a', 'notes', 'third important note').event

    expect(board.pin('a', e1.id).pinned).toBe(true)
    expect(board.pin('a', e2.id).pinned).toBe(true)

    const r3 = board.pin('a', e3.id)
    expect(r3.pinned).toBe(false)
    expect(r3.error).toBeDefined()
    expect(r3.pins.sort()).toEqual([e1.id, e2.id].sort())

    board.unpin('a', e1.id)
    expect(board.pin('a', e3.id).pinned).toBe(true)
    expect(board.pins().map(p => p.eventId).sort()).toEqual([e2.id, e3.id].sort())
  })

  it('FTS query finds events by distinctive body text', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'notes', purpose: 'scratch notes', tags: ['notes'] })
    const z = board.post('a', 'notes', 'zymurgy is the study of fermentation').event
    const o = board.post('a', 'notes', 'orbital mechanics requires delta-v budgeting').event

    const res = log.query({ text: 'zymurgy' })
    expect(res.map(e => e.id)).toContain(z.id)
    expect(res.map(e => e.id)).not.toContain(o.id)
  })

  it('punctuation-only text queries match nothing instead of everything', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'notes', purpose: 'scratch notes', tags: ['notes'] })
    board.post('a', 'notes', 'a perfectly ordinary body')

    expect(log.query({ text: '???!!!' })).toEqual([])
    expect(log.query({ text: '""' })).toEqual([])
    expect(log.query({ text: '--' })).toEqual([])
  })

  it('FTS matches non-ASCII terms', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'notes', purpose: 'scratch notes', tags: ['notes'] })
    const ru = board.post('a', 'notes', 'привет из роя агентов').event
    const en = board.post('a', 'notes', 'greetings from the agent swarm').event

    const res = log.query({ text: 'привет' })
    expect(res.map(e => e.id)).toEqual([ru.id])
    expect(res.map(e => e.id)).not.toContain(en.id)
  })

  it('query by channels is case-insensitive and covers the alias family', () => {
    const { log, board } = fresh()
    board.createChannel('a', { name: 'Notes', purpose: 'scratch notes', tags: ['notes'] })
    const p1 = board.post('a', 'notes', 'first note').event // stored under 'Notes'

    // single-channel sugar, wrong case
    expect(log.query({ channel: 'NOTES', types: ['post'] }).map(e => e.id)).toEqual([p1.id])

    board.createChannel('a', { name: 'scratch', purpose: 'wholly unrelated things', tags: [] }, true)
    const p2 = board.post('a', 'scratch', 'second note').event // pre-merge, stored under 'scratch'
    board.merge('a', 'scratch', 'Notes')
    const p3 = board.post('a', 'scratch', 'third note').event // post-merge, lands under 'Notes'

    // the channel family covers pre- and post-merge history in one query
    const family = board.channelFamily('scratch')!
    expect(family.sort()).toEqual(['Notes', 'scratch'])
    const ids = log.query({ channels: family.map(n => n.toUpperCase()), types: ['post'] }).map(e => e.id)
    expect(ids).toEqual([p1.id, p2.id, p3.id])

    // explicitly-empty channels matches nothing
    expect(log.query({ channels: [] })).toEqual([])
  })
})
