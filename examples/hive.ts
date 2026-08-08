/**
 * Runnable demo: the hive console — create, watch, stop, and archive swarms
 * from the browser. Each swarm is a sqlite event log under swarms/.
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/hive.ts
 *
 * Multi-provider: set any of OPENAI_API_KEY, GEMINI_API_KEY (or
 * GOOGLE_API_KEY), or OPENROUTER_API_KEY as well and those models join the
 * pool. Each publishes a manifest (strengths / cautions / cost), and the
 * overseer picks per spawn via list_models. Anthropic stays the default and
 * fills the heavy/standard/light tiers.
 *
 * Everything else — creating swarms, giving them tasks, stopping them —
 * happens in the UI.
 */
import {
  AnthropicAdapter,
  GeminiAdapter,
  Hive,
  OpenAIAdapter,
  OpenRouterAdapter,
  Swarm,
  librarianSpec,
  startHive,
} from '../src/index.js'
import type { ModelAdapter } from '../src/index.js'

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.')
    console.error('Set it and re-run:')
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...')
    console.error('  npx tsx examples/hive.ts')
    process.exit(1)
  }

  // Anthropic is always present: the swarm default plus the three tiers.
  const detected: string[] = ['anthropic']

  // Extra providers join the pool only when their key is present. Each gets a
  // manifest with a DIFFERENT profile so the overseer has a real reason to
  // reach for one over another — the cautions are where guardrails and weak
  // spots live, in words a spawner can reason over.
  const adapters: ModelAdapter[] = []

  if (process.env.OPENAI_API_KEY) {
    adapters.push(
      new OpenAIAdapter({
        model: 'gpt-5',
        manifest: {
          provider: 'openai',
          strengths: [
            'strong general reasoning',
            'reliable tool/function calling',
            'strict structured JSON output',
          ],
          cautions: [
            'no first-class thinking-block replay across a model switch',
            'content policy differs from Anthropic — may refuse some adversarial-security framing',
          ],
          costClass: 'moderate',
        },
      }),
    )
    detected.push('openai')
  }

  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    adapters.push(
      new GeminiAdapter({
        model: 'gemini-2.5-pro',
        manifest: {
          provider: 'google',
          strengths: [
            'native vision / multimodal',
            'very long context for whole-corpus reads',
            'cheap high-volume scanning',
          ],
          cautions: [
            'distinct safety filters — can block or truncate on sensitive content differently than the others',
            'looser adherence to strict JSON schemas; validate outputs',
          ],
          costClass: 'cheap',
        },
      }),
    )
    detected.push('gemini')
  }

  if (process.env.OPENROUTER_API_KEY) {
    adapters.push(
      new OpenRouterAdapter({
        // A gateway: point `model` at any OpenRouter slug (open-weight or
        // hosted). Swap the default to route a caste at a specific model.
        model: 'meta-llama/llama-3.3-70b-instruct',
        manifest: {
          provider: 'openrouter',
          strengths: [
            'gateway to many models (open-weight and hosted) behind one key',
            'route to a cheaper or specialized model when the frontier is overkill',
            'OpenAI-compatible, so a local server via baseURL works the same way',
          ],
          cautions: [
            'quality/guardrails vary by the underlying model, not by OpenRouter',
            'tool-calling and JSON reliability depend on the routed model',
          ],
          costClass: 'cheap',
        },
      }),
    )
    detected.push('openrouter')
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
        // The cross-provider pool. Anthropic fills the default + tiers; these
        // are extra, self-describing models the overseer can pick by name via
        // list_models / spawn model:<name>. Empty when no other keys are set.
        adapters,
        hiveNames: true,
        maxAgents: 8,
        maxTotalTurns: 60,
        // Hold at the cap instead of ending, so bumping the turns slider in
        // the viewer resumes the same run. Stop from the hive to end it.
        holdAtCap: true,
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
  console.log(`Providers detected: ${detected.join(', ')}`)
  if (detected.length === 1) {
    console.log('(Set OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY to add more models.)')
  }
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
