import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Swarm } from '../src/core/runtime.js'
import { EventLog } from '../src/core/log.js'
import { MockAdapter, turnOf } from '../src/adapters/mock.js'
import type { TurnRequest } from '../src/adapters/types.js'
import type { SwarmEvent } from '../src/core/events.js'

// Agent prompts carry a ROLE:<name> marker; it shows up in the system prompt
// (role prompt appended) and/or the first user message, so check both.
function isAgent(req: TurnRequest, marker: string): boolean {
  if (req.system.includes(marker)) return true
  return req.messages.some(m => m.role === 'user' && m.content.includes(marker))
}

describe('Swarm runtime', () => {
  it('caps spawning at maxAgents and surfaces the error as a tool result', async () => {
    const turnsByAgent: Record<string, number> = {}
    let rootToolResults: Array<{ toolCallId: string; content: string; isError?: boolean }> | null =
      null

    const adapter = new MockAdapter(req => {
      if (isAgent(req, 'ROLE:root')) {
        const n = (turnsByAgent.root = (turnsByAgent.root ?? 0) + 1)
        if (n === 1) {
          return turnOf([
            { name: 'spawn', input: { name: 'w1', role: 'worker', prompt: 'ROLE:w1 do work' } },
            { name: 'spawn', input: { name: 'w2', role: 'worker', prompt: 'ROLE:w2 do work' } },
            { name: 'spawn', input: { name: 'w3', role: 'worker', prompt: 'ROLE:w3 do work' } },
          ])
        }
        for (const m of req.messages) {
          if (m.role === 'tool_results' && m.results.length === 3) rootToolResults = m.results
        }
        return turnOf([{ name: 'complete', input: { summary: 'root done' } }])
      }
      // any worker that made it in just finishes
      return turnOf([{ name: 'complete', input: { summary: 'worker done' } }])
    })

    const swarm = new Swarm({ adapter, maxAgents: 2, maxTotalTurns: 30 })
    const result = await swarm.run('spawn three workers', { prompt: 'ROLE:root spawn workers' })

    expect(result.agents).toHaveLength(2)
    expect(result.agents).toContain('overseer')
    expect(result.agents).toContain('w1')

    expect(rootToolResults).not.toBeNull()
    const third = rootToolResults![2]
    expect(third.isError === true || /error/i.test(third.content)).toBe(true)

    expect(result.turns).toBeLessThan(30)
  })

  it('wakes a subscribed idle agent when a matching event is posted', async () => {
    const turnsByAgent: Record<string, number> = {}
    let wakeMessage: string | null = null

    const adapter = new MockAdapter(req => {
      if (isAgent(req, 'ROLE:root')) {
        const n = (turnsByAgent.root = (turnsByAgent.root ?? 0) + 1)
        if (n === 1) {
          return turnOf([
            {
              name: 'create_channel',
              input: { name: 'findings', purpose: 'research findings', tags: ['research'] },
            },
            {
              name: 'spawn',
              input: {
                name: 'watcher',
                role: 'watcher',
                prompt: 'ROLE:watcher wait for findings',
                // both spellings so either the verb shape (tags) or the
                // SubscriptionFilter shape (tagsAny) is honored
                subscriptions: [{ tags: ['finding'], tagsAny: ['finding'] }],
              },
            },
          ])
        }
        if (n === 2) {
          return turnOf([
            {
              name: 'post',
              input: {
                channel: 'findings',
                body: 'zymurgy breakthrough discovered in the archive',
                tags: ['finding'],
              },
            },
          ])
        }
        return turnOf([{ name: 'complete', input: { summary: 'root done' } }])
      }
      // watcher: idle until a wake message mentioning the finding arrives
      const wake = req.messages.find(
        m => m.role === 'user' && m.content.includes('zymurgy'),
      )
      if (wake && wake.role === 'user') {
        wakeMessage = wake.content
        return turnOf([{ name: 'complete', input: { summary: 'watcher saw the finding' } }])
      }
      return turnOf([{ name: 'idle', input: { reason: 'waiting for findings' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 30 })
    const result = await swarm.run('watch for findings', { prompt: 'ROLE:root run the show' })

    expect(result.finalSummaries.watcher).toBe('watcher saw the finding')
    expect(wakeMessage).not.toBeNull()
    expect(wakeMessage!).toContain('zymurgy')
    expect(result.turns).toBeLessThan(30)
  })

  it('auto-idles agents that return no tool calls and terminates the run', async () => {
    let calls = 0
    const adapter = new MockAdapter(() => {
      calls++
      return turnOf([], 'hmm, nothing to do')
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 25 })
    const result = await swarm.run('do nothing in particular')

    expect(result.agents).toEqual(['overseer'])
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(result.turns).toBeLessThanOrEqual(3) // idles immediately, never loops to the cap
    expect(calls).toBeLessThanOrEqual(3)
    expect(Object.keys(result.finalSummaries)).toHaveLength(0)
  })

  it('does not livelock when broadly subscribed agents idle at each other', async () => {
    let rootTurns = 0
    const adapter = new MockAdapter(req => {
      if (isAgent(req, 'ROLE:root')) {
        rootTurns++
        if (rootTurns === 1) {
          return turnOf([
            { name: 'spawn', input: { name: 'w1', role: 'worker', prompt: 'ROLE:w1 wait around' } },
            { name: 'subscribe', input: { text_includes: ['waiting'] } },
            { name: 'idle', input: { reason: 'waiting for workers' } },
          ])
        }
        return turnOf([{ name: 'idle', input: { reason: 'waiting some more' } }])
      }
      // worker: subscribe just as broadly on its first turn, then idle forever
      const first = !req.messages.some(m => m.role === 'tool_results')
      if (first) {
        return turnOf([
          { name: 'subscribe', input: { text_includes: ['waiting'] } },
          { name: 'idle', input: { reason: 'waiting for direction' } },
        ])
      }
      return turnOf([{ name: 'idle', input: { reason: 'still waiting' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 40 })
    const result = await swarm.run('sit around', { prompt: 'ROLE:root coordinate' })

    // agent_idle is bookkeeping: it must not wake broad subscribers, so the
    // run ends as soon as both agents idle instead of ping-ponging to the cap.
    expect(result.turns).toBeLessThanOrEqual(4)
    expect(result.turns).toBeLessThan(40)
  })

  it('wakes a subscriber to a pre-merge channel name on posts to the canonical channel', async () => {
    let rootTurns = 0
    let wakeMessage: string | null = null
    const adapter = new MockAdapter(req => {
      if (isAgent(req, 'ROLE:root')) {
        rootTurns++
        if (rootTurns === 1) {
          return turnOf([
            { name: 'create_channel', input: { name: 'alpha', purpose: 'first workstream' } },
            { name: 'create_channel', input: { name: 'beta', purpose: 'second workstream' } },
            {
              name: 'spawn',
              input: {
                name: 'watcher',
                role: 'watcher',
                prompt: 'ROLE:watcher watch alpha',
                subscriptions: [{ channels: ['alpha'] }],
              },
            },
            { name: 'merge_channels', input: { from: 'alpha', to: 'beta' } },
            { name: 'post', input: { channel: 'beta', body: 'quixotic result landed' } },
          ])
        }
        return turnOf([{ name: 'complete', input: { summary: 'root done' } }])
      }
      const wake = req.messages.find(m => m.role === 'user' && m.content.includes('quixotic'))
      if (wake && wake.role === 'user') {
        wakeMessage = wake.content
        return turnOf([{ name: 'complete', input: { summary: 'watcher saw the post' } }])
      }
      return turnOf([{ name: 'idle', input: { reason: 'nothing yet' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 30 })
    const result = await swarm.run('merge then post', { prompt: 'ROLE:root run it' })

    expect(result.finalSummaries.watcher).toBe('watcher saw the post')
    expect(wakeMessage).not.toBeNull()
    expect(wakeMessage!).toContain('#beta')
    expect(result.turns).toBeLessThan(30)
  })

  it('does not replay a pre-existing dbPath as wakes or onEvent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmlord-test-'))
    const dbPath = join(dir, 'swarm.db')
    try {
      const prior = new EventLog(dbPath)
      prior.append({
        type: 'post',
        agent: 'old-agent',
        channel: 'archive',
        body: 'ancient history entry',
        tags: [],
        refs: [],
        meta: {},
      })
      const priorLastId = prior.lastId()
      prior.close()

      const seen: SwarmEvent[] = []
      let sawAncient = false
      const adapter = new MockAdapter(req => {
        if (req.messages.some(m => m.role === 'user' && m.content.includes('ancient history'))) {
          sawAncient = true
        }
        return turnOf([{ name: 'complete', input: { summary: 'done' } }])
      })

      const swarm = new Swarm({ adapter, dbPath, maxTotalTurns: 10, onEvent: e => seen.push(e) })
      await swarm.run('fresh run', {
        prompt: 'ROLE:root fresh',
        subscriptions: [{ types: ['post'] }],
      })

      expect(seen.length).toBeGreaterThan(0) // this run's own events still fire
      expect(seen.every(e => e.id > priorLastId)).toBe(true)
      expect(sawAncient).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty subscription filter as a tool error', async () => {
    let subscribeResult: { content: string; isError?: boolean } | null = null
    let turns = 0
    const adapter = new MockAdapter(req => {
      turns++
      if (turns === 1) {
        // empty arrays count as "not provided" — this is an empty filter
        return turnOf([{ name: 'subscribe', input: { channels: [] } }])
      }
      for (const m of req.messages) {
        if (m.role === 'tool_results') subscribeResult = m.results[0] ?? null
      }
      return turnOf([{ name: 'complete', input: { summary: 'done' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 10 })
    await swarm.run('subscribe badly')

    expect(subscribeResult).not.toBeNull()
    expect(subscribeResult!.isError).toBe(true)
    expect(subscribeResult!.content).toMatch(/constraint/i)
  })

  it('discards tool calls from a max_tokens turn and lets the agent retry', async () => {
    let turns = 0
    let truncationNote: string | null = null
    const adapter = new MockAdapter(req => {
      turns++
      if (turns === 1) {
        return {
          ...turnOf([
            { name: 'create_channel', input: { name: 'trunc-chan', purpose: 'should never exist' } },
          ]),
          stopReason: 'max_tokens' as const,
        }
      }
      for (const m of req.messages) {
        if (m.role === 'user' && /cut off/i.test(m.content)) truncationNote = m.content
      }
      return turnOf([{ name: 'complete', input: { summary: 'retried' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 10 })
    const result = await swarm.run('truncate me')

    expect(swarm.board.resolve('trunc-chan')).toBeNull() // the tool call never executed
    expect(truncationNote).not.toBeNull()
    expect(result.finalSummaries.overseer).toBe('retried') // agent stayed ready and retried
  })

  it('marks an agent done on adapter error without killing the run', async () => {
    let rootTurns = 0
    const adapter = new MockAdapter(req => {
      if (isAgent(req, 'ROLE:root')) {
        rootTurns++
        if (rootTurns === 1) {
          return turnOf([
            { name: 'spawn', input: { name: 'w1', role: 'worker', prompt: 'ROLE:w1 explode' } },
          ])
        }
        return turnOf([{ name: 'complete', input: { summary: 'root survived' } }])
      }
      throw new Error('simulated 500')
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 20 })
    const result = await swarm.run('survive failures', { prompt: 'ROLE:root delegate' })

    expect(result.finalSummaries.overseer).toBe('root survived')
    expect(result.finalSummaries.w1).toContain('adapter error: simulated 500')
    const systemEvents = swarm.log.query({ types: ['system'] })
    expect(systemEvents.some(e => e.agent === 'w1' && e.body.includes('simulated 500'))).toBe(true)
  })

  it('uses SwarmOptions.root as overseer defaults, overridden field-by-field by run()', async () => {
    let seenSystem = ''
    const adapter = new MockAdapter(req => {
      seenSystem = req.system
      return turnOf([{ name: 'complete', input: { summary: 'done' } }])
    })

    const swarm = new Swarm({
      adapter,
      root: { name: 'hive-tyrant', role: 'synapse', prompt: 'ROLE:tyrant command the brood' },
    })
    const result = await swarm.run('task', { role: 'warlord' })

    expect(result.agents).toContain('hive-tyrant')      // from options.root
    expect(seenSystem).toContain('Your role: warlord')  // run() arg wins
    expect(seenSystem).toContain('ROLE:tyrant')         // prompt from options.root
  })

  it('applies protocolPreamble and protocolAppendix to every agent system prompt', async () => {
    const systems: string[] = []
    const adapter = new MockAdapter(req => {
      systems.push(req.system)
      return turnOf([{ name: 'complete', input: { summary: 'done' } }])
    })

    const swarm = new Swarm({
      adapter,
      protocolPreamble: 'CUSTOM-PROTOCOL: obey the hive mind.',
      protocolAppendix: 'HOUSE-RULE: post in lowercase.',
    })
    await swarm.run('task')

    expect(systems[0]).toContain('CUSTOM-PROTOCOL: obey the hive mind.')
    expect(systems[0]).toContain('HOUSE-RULE: post in lowercase.')
    expect(systems[0]).not.toContain('You are one agent in a swarm')
  })

  it('routes turns through a per-agent adapter override and reports it in snapshots', async () => {
    const defaultCalls: string[] = []
    const scoutCalls: string[] = []
    const name = (req: TurnRequest) => /Your name is "([^"]+)"/.exec(req.system)?.[1] ?? '?'

    const defaultAdapter = new MockAdapter(req => {
      defaultCalls.push(name(req))
      const n = defaultCalls.filter(a => a === name(req)).length
      if (name(req) === 'overseer' && n === 1) {
        return turnOf([{ name: 'idle', input: {} }])
      }
      return turnOf([{ name: 'complete', input: { summary: 'done' } }])
    })
    const scoutAdapter = new MockAdapter(req => {
      scoutCalls.push(name(req))
      return turnOf([{ name: 'complete', input: { summary: 'scouted' } }])
    })
    Object.defineProperty(scoutAdapter, 'name', { value: 'scout-model' })

    const swarm = new Swarm({ adapter: defaultAdapter, maxTotalTurns: 10 })
    swarm.spawn(null, { name: 'scout', role: 'scout', prompt: 'scout it', adapter: scoutAdapter })
    const result = await swarm.run('task')

    expect(scoutCalls).toContain('scout')
    expect(defaultCalls).not.toContain('scout')
    expect(result.finalSummaries.scout).toBe('scouted')

    const frames = swarm.snapshot().agents
    expect(frames.find(a => a.name === 'scout')?.adapter).toBe('scout-model')
    expect(frames.find(a => a.name === 'overseer')?.adapter).toBe('mock')
  })

  it('refuses idle when the agent has no subscriptions, allows it after subscribing', async () => {
    let n = 0
    let idleRefusal: string | null = null
    const adapter = new MockAdapter(req => {
      n++
      if (n === 1) return turnOf([{ name: 'idle', input: { reason: 'waiting' } }])
      for (const m of req.messages) {
        if (m.role === 'tool_results' && m.results[0]?.isError) {
          idleRefusal = m.results[0].content
        }
      }
      if (n === 2) {
        return turnOf([
          { name: 'subscribe', input: { channels: ['findings'] } },
          { name: 'idle', input: { reason: 'waiting properly now' } },
        ])
      }
      return turnOf([{ name: 'complete', input: { summary: 'unreachable' } }])
    })

    const swarm = new Swarm({ adapter, maxTotalTurns: 10 })
    const result = await swarm.run('wait for things')

    expect(idleRefusal).not.toBeNull()
    expect(idleRefusal!).toContain('no subscriptions')
    // Second idle (with a subscription) succeeded: agent parked, run ended.
    expect(result.turns).toBe(2)
    expect(swarm.snapshot().agents[0]?.status).toBe('idle')
  })
})
