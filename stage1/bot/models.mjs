// Per-clanker LLM routing. Every clanker can think with a different model.
//
// Providers are plain OpenAI-compatible chat-completions endpoints declared
// with environment variables; the built-in `kimi` provider keeps the
// historical RunPod Kimi K3 configuration as the default.
//
//   CLANKER_MODELS=Cinder=deepseek,Vex=openrouter,Mira=kimi
//   DEFAULT_LLM_PROVIDER=kimi
//   LLM_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
//   LLM_DEEPSEEK_API_KEY=sk-...
//   LLM_DEEPSEEK_MODEL=deepseek-chat
//
// Unlisted clankers use DEFAULT_LLM_PROVIDER. A misconfigured provider
// yields labeled plan errors (the controller falls back to its last plan and
// policy behavior) — it never silently pretends to be another model.
import { makePlanner, KIMI_URL, KIMI_MODEL } from './llm.mjs'

export const DEFAULT_PROVIDER = process.env.DEFAULT_LLM_PROVIDER ?? 'kimi'

/** Parse CLANKER_MODELS into { lowercasedName: providerId }. */
export function parseClankerModels(spec) {
  const routes = {}
  if (typeof spec !== 'string') return routes
  for (const pair of spec.split(',')) {
    const [name, provider] = pair.split('=').map((s) => s?.trim())
    if (name && provider) routes[name.toLowerCase()] = provider
  }
  return routes
}

/** Resolve a provider id's endpoint configuration from the environment. */
export function providerConfig(id, env = process.env) {
  if (!id) return null
  if (id.toLowerCase() === 'kimi')
    return {
      id: 'kimi',
      baseUrl: env.KIMI_BASE_URL ?? KIMI_URL,
      model: env.KIMI_MODEL ?? KIMI_MODEL,
      apiKey: env.RUNPOD_API_KEY ?? null,
    }
  const prefix = `LLM_${id.toUpperCase()}`
  return {
    id,
    baseUrl: env[`${prefix}_BASE_URL`] ?? null,
    model: env[`${prefix}_MODEL`] ?? null,
    apiKey: env[`${prefix}_API_KEY`] ?? null,
  }
}

/**
 * The planner for one clanker: { name, describe, plan, reflect, discuss }.
 * Always returns a client; an underconfigured provider reports labeled
 * errors from its calls instead of throwing at startup.
 */
export function plannerFor(botName, { env = process.env } = {}) {
  const routes = parseClankerModels(env.CLANKER_MODELS)
  const id = routes[botName.toLowerCase()] ?? DEFAULT_PROVIDER
  const config = providerConfig(id, env)
  const planner = makePlanner({
    name: config.id,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
  return planner
}
