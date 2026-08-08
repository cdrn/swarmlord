/**
 * Runnable demo: the hive console — create, watch, stop, and archive swarms
 * from the browser. Each swarm is a sqlite event log under swarms/.
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/hive.ts
 *
 * Everything else — creating swarms, giving them tasks, stopping them —
 * happens in the UI.
 */
import { AnthropicAdapter, Hive, Swarm, librarianSpec, startHive } from '../src/index.js'

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.')
    console.error('Set it and re-run:')
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...')
    console.error('  npx tsx examples/hive.ts')
    process.exit(1)
  }

  const hive = new Hive({
    dir: 'swarms',
    createSwarm: dbPath => {
      const swarm = new Swarm({
        adapter: new AnthropicAdapter(),
        dbPath,
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
        maxTotalTurns: 60,
      })
      swarm.spawn(null, librarianSpec())
      return swarm
    },
  })

  const handle = await startHive(hive)
  const banner = `  the hive: ${handle.url}  `
  console.log('')
  console.log('='.repeat(banner.length))
  console.log(banner)
  console.log('='.repeat(banner.length))
  console.log('')
  console.log('Create, watch, stop, and archive swarms in the UI.')
  console.log('Swarm logs live under swarms/ — ctrl-c to exit.')

  // The HTTP server holds the event loop open; close cleanly on ctrl-c.
  process.on('SIGINT', () => {
    void handle.close().then(() => process.exit(0))
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
