import { describe, it, expect } from 'vitest'
import { Swarm } from '../src/core/runtime.js'
import { MockAdapter, turnOf } from '../src/adapters/mock.js'
import type { TurnRequest } from '../src/adapters/types.js'
import type { SwarmEvent, ChannelInfo } from '../src/core/events.js'
import { startViewer } from '../src/viewer/server.js'

function isAgent(req: TurnRequest, marker: string): boolean {
  if (req.system.includes(marker)) return true
  return req.messages.some(m => m.role === 'user' && m.content.includes(marker))
}

/** Runs a tiny scripted swarm so the log has channels, posts, and spawns. */
async function fixtureSwarm(): Promise<Swarm> {
  let rootTurns = 0
  const adapter = new MockAdapter(req => {
    if (isAgent(req, 'ROLE:root')) {
      rootTurns++
      if (rootTurns === 1) {
        return turnOf([
          {
            name: 'create_channel',
            input: { name: 'findings', purpose: 'research findings', tags: ['research'] },
          },
          { name: 'spawn', input: { name: 'scout', role: 'scout', prompt: 'ROLE:scout look around' } },
          { name: 'post', input: { channel: 'findings', body: 'first observation logged' } },
        ])
      }
      return turnOf([{ name: 'complete', input: { summary: 'root done' } }])
    }
    return turnOf([{ name: 'complete', input: { summary: 'scout done' } }])
  })

  const swarm = new Swarm({ adapter, maxTotalTurns: 20 })
  await swarm.run('viewer fixture task', { prompt: 'ROLE:root set the stage' })
  return swarm
}

describe('viewer server', () => {
  it('serves the UI page at /', async () => {
    const swarm = await fixtureSwarm()
    const handle = await startViewer(swarm, { port: 0 })
    try {
      const res = await fetch(`${handle.url}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('<html')
    } finally {
      await handle.close()
    }
  })

  it('reports the actual bound port when listening on port 0', async () => {
    const swarm = await fixtureSwarm()
    const handle = await startViewer(swarm, { port: 0 })
    try {
      expect(handle.port).toBeGreaterThan(0)
      expect(handle.url).toContain(String(handle.port))
    } finally {
      await handle.close()
    }
  })

  it('serves swarm state at /api/state', async () => {
    const swarm = await fixtureSwarm()
    const handle = await startViewer(swarm, { port: 0 })
    try {
      const res = await fetch(`${handle.url}/api/state`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const state = (await res.json()) as {
        snapshot: { agents: Array<{ name: string; status: string }>; lastEventId: number }
        channels: ChannelInfo[]
        pins: Array<{ eventId: number; agent: string }>
      }
      expect(Array.isArray(state.snapshot.agents)).toBe(true)
      const names = state.snapshot.agents.map(a => a.name)
      expect(names).toContain('overseer')
      expect(names).toContain('scout')
      expect(state.snapshot.lastEventId).toBeGreaterThan(0)
      expect(Array.isArray(state.channels)).toBe(true)
      expect(state.channels.map(c => c.name)).toContain('findings')
      expect(Array.isArray(state.pins)).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('serves the event log at /api/events with ascending ids and honors since_id', async () => {
    const swarm = await fixtureSwarm()
    const handle = await startViewer(swarm, { port: 0 })
    try {
      const all = (await (await fetch(`${handle.url}/api/events`)).json()) as SwarmEvent[]
      expect(all.length).toBeGreaterThan(0)
      for (let i = 1; i < all.length; i++) {
        expect(all[i]!.id).toBeGreaterThan(all[i - 1]!.id)
      }
      expect(all.some(e => e.type === 'post' && e.body.includes('first observation'))).toBe(true)

      const mid = all[Math.floor(all.length / 2)]!.id
      const later = (await (
        await fetch(`${handle.url}/api/events?since_id=${mid}`)
      ).json()) as SwarmEvent[]
      expect(later.length).toBeGreaterThan(0)
      expect(later.every(e => e.id > mid)).toBe(true)
      expect(later.length).toBe(all.filter(e => e.id > mid).length)
    } finally {
      await handle.close()
    }
  })

  it('404s on unknown paths', async () => {
    const swarm = await fixtureSwarm()
    const handle = await startViewer(swarm, { port: 0 })
    try {
      const res = await fetch(`${handle.url}/no/such/path`)
      expect(res.status).toBe(404)
    } finally {
      await handle.close()
    }
  })
})
