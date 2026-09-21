// LLM clients for the character experiment. Kimi = reflection/stance, Jev = bounded action.
import './env.mjs'
// Every call carries a deadline; responses are tagged with the observation revision
// they answered, so the controller can discard stale ones.
// One retry on network/5xx errors (Jev 503'd on us in stage 0).

const KIMI_URL = process.env.KIMI_BASE_URL ?? 'https://api.runpod.ai/v2/moonshot-kimi/openai/v1'
const KIMI_MODEL = process.env.KIMI_MODEL ?? 'kimi-k3'
const TYPESAFE_URL = process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai'
const JEV_MODEL = process.env.JEV_MODEL ?? 'jev-latest'

async function post(url, key, body, deadlineMs) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), deadlineMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (res.ok) return { ok: true, json: JSON.parse(text), status: res.status }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      if (res.status >= 400 && res.status < 500) break // don't retry 4xx
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: String(lastErr) }
}

/**
 * Ask Kimi to reflect on a consequential event and update Cinder's stance.
 * Returns { belief, intention, says } or { error }.
 */
export async function kimiReflect({ identity, memoryContext, event, observation, obsRevision }) {
  const key = process.env.RUNPOD_API_KEY
  const body = {
    model: KIMI_MODEL,
    max_tokens: 900,
    messages: [
      {
        role: 'system',
        content:
          `You are ${identity.name}, a contestant in a Minecraft survival arena. ` +
          `Origin: ${identity.origin} Motive: ${identity.motive} ` +
          `Dispositions: ${identity.dispositions.join(', ')}. ` +
          `You interpret events according to your personality and memories. ` +
          `Respond with ONLY a JSON object: {"belief": "what you now think is true (one sentence)", ` +
          `"intention": "what you intend to do about it (one sentence)", ` +
          `"says": "one short line you say aloud, in character"}. No markdown.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          your_goal: identity.current_goal,
          recent_memory: memoryContext,
          current_situation: observation,
          event_to_interpret: event,
        }),
      },
    ],
  }
  const r = await post(`${KIMI_URL}/chat/completions`, key, body, 30_000)
  if (!r.ok) return { error: r.error, obsRevision }
  const content = r.json.choices?.[0]?.message?.content ?? ''
  try {
    const json = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1))
    return { ...json, model: r.json.model, usage: r.json.usage, obsRevision }
  } catch {
    return { error: `unparseable reflection: ${content.slice(0, 200)}`, obsRevision }
  }
}

/**
 * Ask Jev for a bounded action choice given Cinder's current stance.
 * options: { key: "description" } — enumerated by the controller, never invented by the model.
 * Returns { choice, confidence, probabilities, model } or { error }.
 */
export async function jevChoose({ identity, stance, observation, questionId, options }) {
  const key = process.env.TYPESAFE_API_KEY
  const body = {
    model: JEV_MODEL,
    state: {
      character: `${identity.name}: ${identity.dispositions.join(', ')}. Goal: ${identity.current_goal}`,
      stance,
      observation,
    },
    questions: {
      [questionId]: {
        type: 'choice',
        instructions: `Given her stance and the situation, what does ${identity.name} do right now?`,
        criteria: options,
      },
    },
  }
  const r = await post(`${TYPESAFE_URL}/v1/systemone`, key, body, 15_000)
  if (!r.ok) return { error: r.error }
  const answer = r.json.answers?.[questionId]
  if (!answer) return { error: `missing answer for ${questionId}: ${JSON.stringify(r.json).slice(0, 200)}` }
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: r.json.model,
    usage: r.json.usage,
  }
}
