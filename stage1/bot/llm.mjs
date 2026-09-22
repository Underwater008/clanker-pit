// LLM clients for the clankers. Kimi = reflection/stance, Jev = bounded action.
// Every call carries a deadline; responses are tagged with the observation
// revision they answered, so the controller can discard stale ones.
// One retry on network/5xx errors (Jev 503'd on us in stage 0).
//
// makePlanner() is provider-agnostic (any OpenAI-compatible chat endpoint),
// so models.mjs can route a different LLM to each clanker. The kimi*
// exports keep the historical names as thin wrappers over the default
// provider.

const KIMI_URL =
  process.env.KIMI_BASE_URL ??
  'https://api.runpod.ai/v2/moonshot-kimi/openai/v1'
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
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (res.ok)
        return { ok: true, json: JSON.parse(text), status: res.status }
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

// Reasoning models often inline their chain of thought inside XML-ish
// thinking tags. The tag names are assembled from fragments so they cannot
// appear literally in this source file.
const THINK_TAG = new RegExp(
  '<(th' + 'ink)(?:ing)?>([\\s\\S]*?)</\\1(?:ing)?>',
  'i',
)
/**
 * Pull inline thinking out of a completion. Some providers send it as a
 * reasoning_content field instead (handled in makePlanner); both end up in
 * the same `thinking` channel shown by the focus view. Never an action.
 */
export function extractThinking(content) {
  if (typeof content !== 'string') return { thinking: '', content: '' }
  const match = content.match(THINK_TAG)
  if (!match) return { thinking: '', content }
  return {
    thinking: match[2].replace(/\s+/g, ' ').trim(),
    content: (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim(),
  }
}

const parseJsonish = (content) => {
  const json = JSON.parse(
    content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1),
  )
  if (!json || typeof json !== 'object') throw new Error('not an object')
  return json
}
const clean = (value, max) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : ''

/**
 * Build a planner client for one OpenAI-compatible endpoint. Prompt
 * contracts are identical across providers so a village can mix models.
 */
export function makePlanner({ name, baseUrl, apiKey, model }) {
  const label = name ?? 'llm'
  async function chat(messages, maxTokens, deadlineMs) {
    if (!apiKey) return { error: `${label} has no API key configured` }
    if (!baseUrl || !model)
      return { error: `${label} is missing a base URL or model id` }
    const r = await post(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      apiKey,
      { model, max_tokens: maxTokens, messages },
      deadlineMs,
    )
    if (!r.ok) return { error: r.error }
    const message = r.json.choices?.[0]?.message ?? {}
    let content = message.content ?? ''
    let thinking =
      typeof message.reasoning_content === 'string'
        ? message.reasoning_content.replace(/\s+/g, ' ').trim().slice(0, 800)
        : ''
    const tagged = extractThinking(content)
    if (tagged.thinking) {
      thinking = (thinking ? `${thinking} ` : '') + tagged.thinking.slice(0, 800)
      content = tagged.content
    }
    return { content, thinking, model: r.json.model }
  }
  return {
    name: label,
    describe: { provider: label, baseUrl: baseUrl ?? null, model: model ?? null },
    async plan({ identity, observation, memoryContext, goals }) {
      const r = await chat(
        [
          {
            role: 'system',
            content: `You are ${identity.name}, a Minecraft survival player. Personality: ${identity.dispositions.join(', ')}. Motivation: ${identity.current_goal}. Plan useful visible work: acquire wood, craft tools, mine stone, build a shelter, find food. You act through ordinary survival mechanics with limited local observations. Adapt when attempts fail; do not claim achievements without recorded results. Choose one goal from the supplied goal list and a short practical plan for the next few minutes. Return ONLY JSON {"goal":"goal_key","intention":"one sentence","steps":["up to four steps"],"says":"one short in-character sentence"}.`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              goals,
              observation,
              recent_memory: memoryContext,
            }),
          },
        ],
        1800,
        60000,
      )
      if (r.error) return { error: r.error }
      try {
        const result = parseJsonish(r.content)
        if (
          !Object.hasOwn(goals, result.goal) ||
          typeof result.intention !== 'string' ||
          !Array.isArray(result.steps)
        )
          throw Error('Invalid goal or plan')
        return {
          goal: result.goal,
          intention: clean(result.intention, 400),
          steps: result.steps
            .filter((s) => typeof s === 'string')
            .slice(0, 4)
            .map((s) => clean(s, 180)),
          says: clean(result.says, 180),
          reasoning: clean(r.thinking, 800),
          model: r.model ?? model,
        }
      } catch (e) {
        return {
          error: `Invalid planner response: ${String(e)}`,
          reasoning: clean(r.thinking, 800),
        }
      }
    },
    async reflect({
      identity,
      memoryContext,
      event,
      observation,
      obsRevision,
    }) {
      const r = await chat(
        [
          {
            role: 'system',
            content:
              `You are ${identity.name}, a clanker in a Minecraft village. ` +
              `Origin: ${identity.origin} Motive: ${identity.current_goal} ` +
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
        900,
        30000,
      )
      if (r.error) return { error: r.error, obsRevision }
      try {
        const json = parseJsonish(r.content)
        return {
          belief: clean(json.belief, 300),
          intention: clean(json.intention, 300),
          says: clean(json.says, 180),
          reasoning: clean(r.thinking, 600),
          model: r.json?.model ?? model,
          obsRevision,
        }
      } catch {
        return {
          error: `unparseable reflection: ${r.content.slice(0, 200)}`,
          obsRevision,
        }
      }
    },
    async discuss({
      identity,
      villageSummary,
      currentRoles,
      othersSoFar,
      situation,
    }) {
      const { SYSTEM_PROMPT, parseDiscussResponse } = await import(
        './council.mjs'
      )
      const r = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT(identity) },
          {
            role: 'user',
            content: JSON.stringify({
              village_status: villageSummary,
              current_roles: currentRoles,
              council_so_far: othersSoFar,
              your_situation: situation,
            }),
          },
        ],
        400,
        30000,
      )
      if (r.error) return { error: r.error }
      const parsed = parseDiscussResponse(r.content)
      if (parsed.error) return { error: parsed.error }
      return {
        role: parsed.role,
        says: parsed.says,
        model: r.model ?? model,
      }
    },
  }
}

export function kimiPlanner(env = process.env) {
  return makePlanner({
    name: 'kimi',
    baseUrl: env.KIMI_BASE_URL ?? KIMI_URL,
    apiKey: env.RUNPOD_API_KEY,
    model: env.KIMI_MODEL ?? KIMI_MODEL,
  })
}

/* Historical names, kept for existing callers (the stage-1 cinder script). */
export const kimiPlan = (args) => kimiPlanner().plan(args)
export const kimiReflect = (args) => kimiPlanner().reflect(args)
export const kimiDiscuss = (args) => kimiPlanner().discuss(args)

/**
 * Ask Jev for a bounded action choice given the clanker's current stance.
 * options: { key: "description" } — enumerated by the controller, never
 * invented by the model. Jev stays the single shared action selector.
 * Returns { choice, confidence, probabilities, model } or { error }.
 */
export async function jevChoose({
  identity,
  stance,
  observation,
  questionId,
  options,
}) {
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
        instructions: `Choose one executable action that makes concrete progress toward ${identity.name}'s current plan. Eat when hungry. Finish prerequisites for tools and construction. Prefer useful work over wandering when materials are available. Avoid repeating failed actions.`,
        criteria: options,
      },
    },
  }
  const r = await post(`${TYPESAFE_URL}/v1/systemone`, key, body, 15000)
  if (!r.ok) return { error: r.error }
  const answer = r.json.answers?.[questionId]
  if (!answer)
    return {
      error: `missing answer for ${questionId}: ${JSON.stringify(r.json).slice(0, 200)}`,
    }
  if (!Object.hasOwn(options, answer.choice))
    return { error: `invalid action returned: ${answer.choice}` }
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: r.json.model,
    usage: r.json.usage,
  }
}

export { KIMI_URL, KIMI_MODEL }
