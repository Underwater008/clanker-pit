// Stage 0 check: one typed Jev Choice decision through TypeSafe System One.
// Proves: route works, typed answer comes back, version/latency/confidence are recordable.
import { requireEnv } from './lib/env.mjs'

const apiKey = requireEnv('TYPESAFE_API_KEY')

const BASE_URL = process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai'
const MODEL = process.env.JEV_MODEL ?? 'jev-latest'

// A small game-like judgment, matching how we plan to use Jev:
// a bounded tactical choice given a character goal and a compact observation.
const body = {
  model: MODEL,
  state: {
    character:
      'Cinder: cautious, distrusts Vex since he took her supplies. Current goal: gear up before the border closes.',
    observation: {
      health: 14,
      weapon: 'wooden sword',
      chest_a: { distance: 'near', contents_seen: ['iron sword'], threats_seen: ['Vex nearby'] },
      chest_b: { distance: 'far', contents_seen: ['bread', 'leather armor'], threats_seen: [] },
      border: 'closing in 90 seconds',
    },
  },
  questions: {
    next_move: {
      type: 'choice',
      instructions: 'Which chest should Cinder go to right now, given her goal and disposition?',
      criteria: {
        chest_a: 'Nearby chest with an iron sword, but Vex is close to it',
        chest_b: 'Farther chest with food and armor, no threats seen',
      },
    },
    vex_threat: {
      type: 'score',
      instructions: 'How dangerous is Vex to Cinder right now?',
      criteria: ['ignorable', 'mild', 'serious', 'immediate'],
    },
  },
}

console.log(`POST ${BASE_URL}/v1/systemone`)
console.log(`model: ${MODEL}`)

const started = performance.now()
const res = await fetch(`${BASE_URL}/v1/systemone`, {
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
  console.log('Error response (record verbatim):\n' + JSON.stringify(json, null, 2))
  process.exit(1)
}

console.log('\n--- Record these in RESULTS.md ---')
console.log('latency (ms):    ', latencyMs)
console.log('Full response:\n' + JSON.stringify(json, null, 2))
