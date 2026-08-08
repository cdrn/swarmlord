/**
 * Viewer demo with a scripted (offline) swarm — no API key needed:
 *
 *   npx tsx examples/viewer-demo.ts
 *
 * An overseer sets up a channel, posts a task, and spawns three unnamed
 * workers (names get generated). Workers claim, post findings — one of them
 * independently duplicates another's conclusion, which the board links — and
 * the overseer wakes, synthesizes, pins, and completes. Watch it live in the
 * viewer; the server stays up afterwards so you can inspect the final board.
 */

import {
  Swarm,
  startViewer,
  type ModelAdapter,
  type ToolCall,
  type TurnRequest,
  type TurnResult,
} from '../src/index.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let callId = 0
function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `tc-${++callId}`, name, input }
}

function turn(text: string, toolCalls: ToolCall[]): TurnResult {
  return { text, toolCalls, usage: { inputTokens: 0, outputTokens: 0 } }
}

const CONVERGENT_FINDING =
  'Forward chambers are structurally sound; resonance readings stable at 0.3.'

class ScriptedAdapter implements ModelAdapter {
  readonly name = 'scripted-demo'
  private readonly turns = new Map<string, number>()

  async turn(req: TurnRequest): Promise<TurnResult> {
    await sleep(1200) // let the viewer breathe
    const agent = /Your name is "([^"]+)"/.exec(req.system)?.[1] ?? 'unknown'
    const role = /Your role: ([^.\n]+)/.exec(req.system)?.[1] ?? ''
    const n = (this.turns.get(agent) ?? 0) + 1
    this.turns.set(agent, n)

    if (role.includes('coordinator')) {
      if (n === 1) {
        return turn('Setting up the board and spawning the brood.', [
          call('create_channel', {
            name: 'findings',
            purpose: 'Field reports from survey workers',
            tags: ['survey'],
          }),
          call('post', {
            channel: 'findings',
            body: 'TASK: survey the hive perimeter — structure, thermals, movement. One report each.',
            tags: ['task'],
          }),
          call('spawn', { role: 'scout', prompt: 'Survey structure. Post one finding to #findings, then complete.' }),
          call('spawn', { role: 'scout', prompt: 'Survey thermals. Post one finding to #findings, then complete.' }),
          call('spawn', { role: 'scout', prompt: 'Survey movement. Post one finding to #findings, then complete.' }),
          call('subscribe', { channels: ['findings'] }),
          call('idle', { reason: 'waiting on survey reports' }),
        ])
      }
      return turn('All reports in. Synthesizing.', [
        call('post', {
          channel: 'findings',
          body: 'SYNTHESIS: perimeter secure. Structure sound (two independent confirmations — convergence noted), thermals nominal, movement clear.',
          tags: ['synthesis'],
        }),
        call('pin', { event_id: 3 }),
        call('complete', { summary: 'Perimeter survey complete; synthesis posted to #findings.' }),
      ])
    }

    // Scouts: post one finding, then complete. The third scout independently
    // reaches the same conclusion as the first — the board links, not blocks.
    if (n === 1) {
      const prompt = req.messages[0]
      const topic = prompt?.role === 'user' ? prompt.content : ''
      const body = topic.includes('thermals')
        ? 'Thermal gradients nominal across the perimeter; no hot spots.'
        : topic.includes('movement')
          ? CONVERGENT_FINDING
          : CONVERGENT_FINDING
      return turn('Survey done, reporting.', [
        call('post', { channel: 'findings', body, tags: ['report'] }),
      ])
    }
    return turn('Report filed.', [call('complete', { summary: 'Survey report posted.' })])
  }
}

const swarm = new Swarm({
  adapter: new ScriptedAdapter(),
  maxAgents: 8,
  maxTotalTurns: 30,
  onEvent: evt =>
    console.log(`  #${evt.id} [${evt.type}] ${evt.agent}${evt.channel ? ` in #${evt.channel}` : ''}`),
})

const viewer = await startViewer(swarm)
console.log(`\nwatch the swarm: ${viewer.url}\n`)
await sleep(4000) // time to open the page before the hive stirs

const result = await swarm.run('Survey the hive perimeter.')

console.log(`\nrun finished: ${result.turns} turns, ${result.agents.length} agents, ${result.events} events`)
console.log('final summaries:', result.finalSummaries)
console.log('\nviewer still serving — ctrl-c to exit')
