import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseClankerModels,
  providerConfig,
  plannerFor,
} from './models.mjs'
import { extractThinking, makePlanner } from './llm.mjs'

test('CLANKER_MODELS routes names to providers, forgiving of spacing and case', () => {
  const routes = parseClankerModels(' Cinder = deepseek , vex=openrouter,')
  assert.deepEqual(routes, { cinder: 'deepseek', vex: 'openrouter' })
  assert.deepEqual(parseClankerModels(''), {})
  assert.deepEqual(parseClankerModels(null), {})
  assert.deepEqual(parseClankerModels('junk'), {})
})

test('provider config: kimi is built-in, custom providers come from env prefixes', () => {
  const kimi = providerConfig('kimi', {
    RUNPOD_API_KEY: 'k',
    KIMI_BASE_URL: 'https://kimi.example/v1',
    KIMI_MODEL: 'kimi-k3',
  })
  assert.equal(kimi.model, 'kimi-k3')
  assert.equal(kimi.apiKey, 'k')
  const custom = providerConfig('DeepSeek', {
    LLM_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_DEEPSEEK_API_KEY: 'sk-x',
    LLM_DEEPSEEK_MODEL: 'deepseek-chat',
  })
  assert.equal(custom.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(custom.apiKey, 'sk-x')
  assert.equal(custom.model, 'deepseek-chat')
  const missing = providerConfig('nowhere', {})
  assert.equal(missing.baseUrl, null)
  assert.equal(missing.apiKey, null)
})

test('plannerFor routes each clanker to its own model and labels errors honestly', async () => {
  const env = {
    RUNPOD_API_KEY: 'kimi-key',
    KIMI_MODEL: 'kimi-k3',
    CLANKER_MODELS: 'Vex=deepseek',
    LLM_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_DEEPSEEK_MODEL: 'deepseek-chat',
    LLM_DEEPSEEK_API_KEY: 'sk-d',
  }
  const vex = plannerFor('Vex', { env })
  const mira = plannerFor('Mira', { env })
  assert.equal(vex.name, 'deepseek')
  assert.equal(vex.describe.model, 'deepseek-chat')
  assert.equal(mira.name, 'kimi', 'unlisted clankers use the default provider')
  // An underconfigured provider reports a labeled error, never a silent
  // switch to another model.
  const broken = plannerFor('Vex', {
    env: { ...env, LLM_DEEPSEEK_API_KEY: '' },
  })
  const r = await broken.plan({
    identity: { name: 'Vex', dispositions: [], current_goal: 'x' },
    observation: {},
    memoryContext: [],
    goals: { a: 'b' },
  })
  assert.match(r.error, /deepseek/)
})

test('inline and field reasoning both land in the thinking channel', () => {
  const open = '<' + 'think>'
  const close = '</' + 'think>'
  const r = extractThinking(`${open} water is heavy ${close}{"role":"guard"}`)
  assert.equal(r.thinking, 'water is heavy')
  assert.equal(r.content, '{"role":"guard"}')
  const none = extractThinking('{"role":"guard"}')
  assert.equal(none.thinking, '')
  assert.equal(none.content, '{"role":"guard"}')
  const weird = extractThinking(undefined)
  assert.deepEqual(weird, { thinking: '', content: '' })
})

test('makePlanner describe exposes provider and model for the focus view', () => {
  const planner = makePlanner({
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    model: 'some-model',
  })
  assert.deepEqual(planner.describe, {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'some-model',
  })
})
