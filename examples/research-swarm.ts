/**
 * Runnable demo: an Anthropic-backed research swarm with a librarian curator.
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/research-swarm.ts "your question"
 *
 * Pass --view (or set SWARMLORD_VIEW) to serve the live viewer while it runs.
 */
import { AnthropicAdapter, Swarm, librarianSpec, startViewer } from '../src/index.js'
import type { SwarmEvent, ViewerHandle } from '../src/index.js'

const DEFAULT_QUESTION =
  'Why did the Library of Alexandria decline, and what myths about its destruction persist?'

function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

function printEvent(evt: SwarmEvent): void {
  const channel = evt.channel ?? '-'
  const dup = evt.duplicateOf !== null ? ` (dup of #${evt.duplicateOf})` : ''
  console.log(
    `  #${evt.id} ${evt.type} ${evt.agent} @${channel} ${truncate(evt.body)}${dup}`,
  )
}

async function main(): Promise<void> {
  const wantView = process.argv.includes('--view') || Boolean(process.env.SWARMLORD_VIEW)

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.')
    console.error('Set it and re-run:')
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...')
    console.error('  npx tsx examples/research-swarm.ts "your question"')
    if (wantView) {
      console.error('(--view needs a run to watch — the viewer only starts once a key is set.)')
    }
    process.exit(1)
  }

  const question = process.argv.slice(2).find(arg => arg !== '--view') ?? DEFAULT_QUESTION

  const swarm = new Swarm({
    adapter: new AnthropicAdapter(),
    // Three castes: the spawner picks a tier per spawn (the verb teaches
    // when); tier-less spawns sample the weights below. Tiers are
    // reassignable at runtime from the viewer's settings drawer.
    tiers: {
      heavy: new AnthropicAdapter({ model: 'claude-fable-5' }),
      standard: new AnthropicAdapter({ model: 'claude-sonnet-4-6' }),
      light: new AnthropicAdapter({ model: 'claude-haiku-4-5' }),
    },
    tierWeights: { standard: 3, light: 1 },
    hiveNames: true,
    maxAgents: 8,
    maxTotalTurns: 40,
    onEvent: printEvent,
    onTurn: ({ agent, turn }) => {
      console.log(`\n--- turn ${turn} · ${agent} ---`)
    },
  })

  swarm.spawn(null, librarianSpec())

  let viewer: ViewerHandle | null = null
  if (wantView) {
    viewer = await startViewer(swarm, {})
    const banner = `  watch the swarm: ${viewer.url}  `
    console.log('')
    console.log('='.repeat(banner.length))
    console.log(banner)
    console.log('='.repeat(banner.length))
    console.log('')
  }

  console.log(`question: ${question}\n`)
  const result = await swarm.run(question)

  console.log('\n=== run finished ===')
  console.log(`turns: ${result.turns}   agents: ${result.agents.join(', ')}   events: ${result.events}`)

  console.log('\n=== final summaries ===')
  if (Object.keys(result.finalSummaries).length === 0) {
    console.log('  (none — no agent called complete)')
  }
  for (const [agent, summary] of Object.entries(result.finalSummaries)) {
    console.log(`\n[${agent}]`)
    console.log(summary)
  }

  console.log('\n=== channel catalog ===')
  const catalog = swarm.board.catalog()
  if (catalog.length === 0) console.log('  (empty)')
  for (const ch of catalog) {
    const tags = ch.tags.length > 0 ? ` [${ch.tags.join(', ')}]` : ''
    console.log(`  ${ch.name}${tags} — ${ch.purpose} (${ch.eventCount} events, by ${ch.createdBy})`)
  }

  if (viewer !== null) {
    const handle = viewer
    console.log(`\nviewer still serving — ctrl-c to exit (${handle.url})`)
    // Keep the process alive so the final board state can be inspected.
    // The HTTP server holds the event loop open; close the log on ctrl-c.
    process.on('SIGINT', () => {
      void handle.close().then(() => {
        swarm.log.close()
        process.exit(0)
      })
    })
  } else {
    swarm.log.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
