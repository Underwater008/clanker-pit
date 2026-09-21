// Stage 0 check: Kimi K3 text response through the RunPod managed endpoint.
// Proves: route works, explicit model ID is accepted, latency and usage are recordable.
import { requireEnv } from './lib/env.mjs'

const apiKey = requireEnv('RUNPOD_API_KEY')

const BASE_URL = process.env.KIMI_BASE_URL ?? 'https://api.runpod.ai/v2/moonshot-kimi/openai/v1'
const MODEL = process.env.KIMI_MODEL ?? 'kimi-k3'

const body = {
  model: MODEL,
  messages: [
    {
      role: 'system',
      content:
        'You are a contestant in a Minecraft survival arena. Answer briefly, in character.',
    },
    {
      role: 'user',
      content:
        'Your name is Cinder. You distrust the contestant named Vex because he took your supplies yesterday. ' +
        'Vex just offered you cooked beef. In one or two sentences, what do you do and why?',
    },
  ],
  max_tokens: 512, // K3 burns reasoning tokens before replying; 120 was entirely consumed by reasoning
}

console.log(`POST ${BASE_URL}/chat/completions`)
console.log(`model: ${MODEL}`)

const started = performance.now()
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})
const latencyMs = Math.round(performance.now() - started)

const text = await res.text()
console.log(`\nHTTP ${res.status} in ${latencyMs} ms`)

let json
try {
  json = JSON.parse(text)
} catch {
  console.log('Non-JSON response body:\n' + text)
  process.exit(1)
}

if (!res.ok) {
  console.log('Error response:\n' + JSON.stringify(json, null, 2))
  process.exit(1)
}

console.log('\n--- Record these in RESULTS.md ---')
console.log('model returned:  ', json.model)
console.log('finish reason:   ', json.choices?.[0]?.finish_reason)
console.log('usage:           ', JSON.stringify(json.usage))
console.log('latency (ms):    ', latencyMs)
console.log('\nReply:\n' + json.choices?.[0]?.message?.content)
