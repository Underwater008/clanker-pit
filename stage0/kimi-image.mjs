// Stage 0 check: does the RunPod Kimi route accept image input?
// The endpoint reference does not document a multimodal payload, so this script
// tries the standard OpenAI image_url format and reports the verbatim outcome.
// A clear provider error here is a useful result — record it in RESULTS.md.
import { requireEnv } from './lib/env.mjs'

const apiKey = requireEnv('RUNPOD_API_KEY')

const BASE_URL = process.env.KIMI_BASE_URL ?? 'https://api.runpod.ai/v2/moonshot-kimi/openai/v1'
const MODEL = process.env.KIMI_MODEL ?? 'kimi-k3'
// Default: self-contained 64x64 green PNG data URL (remote image URLs gave HTTP 500
// on this route when unreachable; a data URL removes server-side fetching from the test).
// Override with TEST_IMAGE_URL to probe remote-URL support separately.
const GREEN_SQUARE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeElEQVR4nO3PQQkAMAzAwGqp3ZmeiD2OQSACLrNnv264oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0ILHLnsQ8LXXCTboAAAAAElFTkSuQmCC'
const IMAGE_URL = process.env.TEST_IMAGE_URL ?? GREEN_SQUARE

const body = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Describe what you see in this image in one sentence. If you cannot see any image, say exactly: NO_IMAGE_RECEIVED',
        },
        { type: 'image_url', image_url: { url: IMAGE_URL } },
      ],
    },
  ],
  max_tokens: 120,
}

console.log(`POST ${BASE_URL}/chat/completions`)
console.log(`model: ${MODEL}`)
console.log(`image: ${IMAGE_URL}`)

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
  console.log('\nProvider rejected the image payload. Verbatim error (record this):')
  console.log(JSON.stringify(json, null, 2))
  process.exit(1)
}

const reply = json.choices?.[0]?.message?.content ?? ''
console.log('\n--- Record these in RESULTS.md ---')
console.log('model returned:  ', json.model)
console.log('usage:           ', JSON.stringify(json.usage))
console.log('latency (ms):    ', latencyMs)
console.log('\nReply:\n' + reply)
console.log(
  reply.includes('NO_IMAGE_RECEIVED')
    ? '\nVerdict: endpoint accepted the request but the image did not reach the model.'
    : '\nVerdict: check the reply describes the actual image before claiming vision works.',
)
