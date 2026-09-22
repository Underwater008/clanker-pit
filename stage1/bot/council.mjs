// The village council: a periodic discussion where every clanker proposes a
// role (guard, builder, smith, coolant, farmer), hears the others, and says
// one line in character. Role assignment itself is deterministic policy that
// honors model proposals; it is never presented as a model decision.
//
// The same discussion doubles as the public agent chat: every line spoken in
// the council is also said in-game (visible in the native POV chat) and
// recorded in the telemetry chat feed.
import { ROLES, ROLE_LABELS } from './village.mjs'

export const SYSTEM_PROMPT = (identity) =>
  `You are ${identity.name}, a clanker in a Minecraft village built around the Server — ` +
  `a machine-monument the village must keep alive. Origin: ${identity.origin} ` +
  `Dispositions: ${identity.dispositions.join(', ')}. Catchphrase flavor: ${identity.catchphrase ?? ''} ` +
  `You are at a village council deciding who does what. Roles: ` +
  `${ROLES.map((r) => `${r} (${ROLE_LABELS[r]})`).join('; ')}. ` +
  `Use your actual inventory and available actions to propose work you can start now; consider roles already proposed by teammates. ` +
  `Reply with ONLY a JSON object: {"role":"chosen role key","says":"one short line you say aloud to the team, in character"}. No markdown.`

export function parseDiscussResponse(content) {
  if (typeof content !== 'string') return { error: 'no content' }
  try {
    const json = JSON.parse(
      content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1),
    )
    const role = ROLES.includes(json.role) ? json.role : null
    const says =
      typeof json.says === 'string' ? json.says.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
    if (!role && !says) return { error: 'no role and no line' }
    return { role, says }
  } catch {
    return { error: `unparseable council reply: ${content.slice(0, 160)}` }
  }
}

/**
 * Deterministic role assignment. Honors unique model proposals in cast order;
 * contested roles go to the earliest claimant and everyone else is filled by
 * policy (previous role first, then round-robin over unfilled roles).
 * Returns { roles: {name: role}, assignments: [{name, role, source}] }.
 */
export function assignRoles(proposals, castOrder, previous = {}) {
  const taken = new Set()
  const roles = {}
  const usage = {}
  const assignments = []
  const claim = (name, role, source) => {
    roles[name] = role
    taken.add(role)
    usage[role] = (usage[role] ?? 0) + 1
    assignments.push({ name, role, source })
  }
  // 1. Unique proposals win outright; contested ones go to the earliest in cast order.
  const claimed = new Map()
  for (const name of castOrder) {
    const p = proposals[name]
    if (p?.role && !claimed.has(p.role)) claimed.set(p.role, name)
  }
  for (const [role, name] of claimed) claim(name, role, 'proposal')
  // 2. Fill everyone else by policy.
  for (const name of castOrder) {
    if (roles[name]) continue
    const prev = previous[name]
    if (prev && !taken.has(prev)) {
      claim(name, prev, 'policy')
      continue
    }
    // Prefer an unfilled role; once every role is taken (more villagers than
    // roles), spread the duplicates as evenly as possible.
    const role =
      ROLES.find((r) => !taken.has(r)) ??
      ROLES.reduce((a, b) => ((usage[a] ?? 0) <= (usage[b] ?? 0) ? a : b))
    claim(name, role, 'policy')
  }
  return { roles, assignments }
}

/**
 * Run one council round. Participants may each carry their own `discuss`
 * (their routed LLM, see models.mjs); a shared `discuss` is the fallback.
 * `discuss({ identity, villageSummary, currentRoles, othersSoFar, situation })`
 * returns { role, says } or { error }. `speak(name, text)` says the line
 * in-game. Bots appear in cast order and hear the lines said before them,
 * so the chat reads like a real discussion.
 */
export async function runCouncil({
  participants, // [{ name, identity, situation, discuss? }]
  villageSummary,
  currentRoles,
  discuss, // fallback for participants without their own discuss
  speak = () => {},
  onMessage = null, // called live with { name, says } as each line is spoken
  log = () => {},
  assign = assignRoles,
}) {
  const castOrder = participants.map((p) => p.name)
  const proposals = {}
  const messages = []
  for (const p of participants) {
    let reply = { error: 'skipped' }
    // Each clanker argues with its own routed LLM (models.mjs); a shared
    // discuss function is the fallback for callers that did not route one.
    const discussWith = p.discuss ?? discuss
    if (!discussWith) {
      log('council_reply_error', { bot: p.name, error: 'no discuss client routed' })
      continue
    }
    try {
      reply = await discussWith({
        identity: p.identity,
        villageSummary,
        currentRoles,
        othersSoFar: messages.slice(-6),
        situation: p.situation,
      })
    } catch (e) {
      reply = { error: String(e) }
    }
    if (reply.error) {
      log('council_reply_error', { bot: p.name, error: reply.error })
      continue
    }
    proposals[p.name] = reply
    if (reply.says) {
      speak(p.name, reply.says)
      messages.push({ name: p.name, says: reply.says })
      // Emit each line as it is spoken so a later failure cannot lose
      // lines that were already said in-game.
      onMessage?.({ name: p.name, says: reply.says })
    } else log('council_silent', { bot: p.name })
  }
  const { roles, assignments } = assign(proposals, castOrder, currentRoles)
  for (const a of assignments)
    log('council_assign', {
      bot: a.name,
      role: a.role,
      source: a.source,
    })
  return {
    roles,
    assignments,
    messages,
    summary: castOrder.map((n) => `${n}→${roles[n]}`).join(', '),
  }
}
