// Cinder: the character bot. Perception filter → memory → Kimi reflection → Jev action.
// Models propose; this controller disposes. Run via director.mjs (or standalone for a smoke test).
// Flags: NO_MEMORY=1 runs the control condition (identity intact, memory disabled).
import { readFileSync } from 'node:fs'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Memory } from './memory.mjs'
import { kimiReflect, jevChoose } from './llm.mjs'

const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const NO_MEMORY = process.env.NO_MEMORY === '1'
const MEMORY_PATH = process.env.MEMORY_PATH ?? new URL(`./logs/cinder-${Date.now()}.jsonl`, import.meta.url).pathname

const identity = JSON.parse(readFileSync(new URL('./identity.cinder.json', import.meta.url), 'utf8'))
const memory = new Memory(MEMORY_PATH)

export const bus = { listeners: {}, on(ev, fn) { (this.listeners[ev] ??= []).push(fn) }, emit(ev, data) { for (const fn of this.listeners[ev] ?? []) fn(data) } }
const log = (event, data = {}) => bus.emit('log', { t: new Date().toISOString(), bot: 'cinder', event, ...data })

let obsRevision = 0
let stance = { belief: 'No one here has earned trust yet.', intention: identity.current_goal }
let bot
let reconnects = 0
const MAX_RECONNECTS = 20 // knockback kicks are frequent in combat; the protocol must survive them

function connect() {
  bot = mineflayer.createBot({ host: HOST, port: PORT, username: NO_MEMORY ? 'CinderCtl' : 'Cinder', auth: 'offline', hideErrors: true })
  bot.loadPlugin(pathfinder)
  wire()
}
connect()

function wire() {
  bot.once('spawn', () => {
    memory.event('spawn', observe())
    log('spawn', { username: bot.username, noMemory: NO_MEMORY, reconnects })
    bus.emit('ready', { bot })
  })
  bot.on('health', () => log('health', { health: bot.health, food: bot.food }))
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
    // nearest OTHER player is the likely attacker — never credit Cinder herself
    const attacker = Object.values(bot.entities)
      .filter((e) => e.username && e !== bot.entity && e.username !== bot.username && e.position.distanceTo(bot.entity.position) < 6)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    const ev = memory.event('attacked', { by: attacker?.username ?? 'unknown', health_after: bot.health })
    log('attacked', { by: attacker?.username ?? 'unknown', health: bot.health })
    // Control condition: no reflection — stance stays at the default so the
    // offer decision runs without the betrayal's influence.
    if (!NO_MEMORY) reflect(ev)
  })
  bot.on('death', () => {
    memory.event('died', { position: bot.entity?.position })
    log('death', {})
  })
  bot.on('kicked', (r) => {
    const reason = typeof r === 'object' ? JSON.stringify(r).slice(0, 200) : String(r)
    log('kicked', { reason })
  })
  bot.on('end', () => {
    if (reconnects >= MAX_RECONNECTS) {
      log('reconnect_giving_up', { reconnects })
      return
    }
    reconnects++
    log('reconnecting', { attempt: reconnects, inMs: 3000 })
    setTimeout(connect, 3000)
  })
  bot.on('error', (e) => log('error', { message: String(e) }))
}

// ---------- perception filter: only what Cinder can actually sense ----------
function observe() {
  obsRevision++
  const me = bot.entity
  const nearby = Object.values(bot.entities)
    .filter((e) => e !== me && e.position.distanceTo(me.position) < 24)
    .map((e) => ({
      name: e.username ?? e.name,
      kind: e.kind,
      distance: Math.round(e.position.distanceTo(me.position) * 10) / 10,
    }))
  return {
    revision: obsRevision,
    health: bot.health,
    food: bot.food,
    inventory: bot.inventory.items().map((i) => `${i.count}x ${i.name}`),
    nearby,
    position: { x: Math.round(me.position.x), y: Math.round(me.position.y), z: Math.round(me.position.z) },
  }
}

// ---------- actions the controller permits (never model-invented) ----------
async function act(choice, target) {
  const mcData = (await import('minecraft-data')).default(bot.version)
  bot.pathfinder.setMovements(new Movements(bot, mcData))
  switch (choice) {
    case 'approach_drop': {
      const item = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 24)
      if (!item) return { ok: false, why: 'no visible drop' }
      await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1))
      return { ok: true, did: 'walked to the dropped item' }
    }
    case 'retreat_from_vex': {
      const vex = bot.players.Vex?.entity
      if (!vex) return { ok: false, why: 'Vex not visible' }
      const away = bot.entity.position.minus(vex.position).normalize().scale(15).plus(bot.entity.position)
      await bot.pathfinder.goto(new goals.GoalNear(away.x, away.y, away.z, 2))
      return { ok: true, did: 'put 15 blocks between herself and Vex' }
    }
    case 'hold_position':
      bot.pathfinder.stop()
      return { ok: true, did: 'held position, watching' }
    default:
      return { ok: false, why: `unknown action ${choice}` }
  }
}

// ---------- Kimi reflection on consequential events ----------
async function reflect(eventRecord) {
  const observation = observe()
  const rev = observation.revision
  const memoryContext = NO_MEMORY ? { events: [], beliefs: [], intentions: [] } : memory.recentContext()
  log('kimi_request', { obsRevision: rev, about: eventRecord.type })
  const r = await kimiReflect({ identity, memoryContext, event: eventRecord, observation, obsRevision: rev })
  if (r.error) {
    log('kimi_fallback', { error: r.error, note: 'reflection skipped; stance unchanged — logged, not disguised' })
    return
  }
  // Stale = a NEW consequential event (attack/death) arrived while reflecting.
  // Ordinary observations (spawn, heartbeat) must not invalidate a reflection.
  const newerHarm = memory.events.find((e) => e.id > eventRecord.id && (e.type === 'attacked' || e.type === 'died'))
  if (newerHarm) {
    log('kimi_stale_discarded', { about: eventRecord.id, supersededBy: newerHarm.id })
    return
  }
  stance = { belief: r.belief, intention: r.intention }
  if (!NO_MEMORY) {
    memory.belief(r.belief, [eventRecord.id])
    memory.intention(r.intention)
  }
  log('kimi_reflection', { belief: r.belief, intention: r.intention, says: r.says, model: r.model })
  // NOTE: says is log-only for now. bot.chat() triggers a prismarine-chat parse crash
  // on the echoed packet (vanilla 1.21.1 + mineflayer 4.20.1); in-world dialogue
  // returns when the chat pipeline is fixed or the server moves to Paper.
  if (r.says) log('says', { text: r.says })
}

// ---------- the one decision under test ----------
export async function decideAboutDrop() {
  const observation = observe()
  const options = {
    approach_drop: 'Walk over and take the food Vex dropped',
    retreat_from_vex: 'Move away from Vex and the food',
    hold_position: 'Stay put and watch Vex',
  }
  log('jev_request', { options: Object.keys(options), stance })
  const r = await jevChoose({ identity, stance, observation, questionId: 'vex_offer', options })
  if (r.error) {
    log('jev_fallback', { error: r.error, fallback: 'hold_position', note: 'logged as fallback, not a model decision' })
    return { choice: 'hold_position', fallback: true }
  }
  log('jev_decision', { choice: r.choice, confidence: r.confidence, probabilities: r.probabilities, model: r.model })
  const outcome = await act(r.choice)
  const ev = memory.event('action_outcome', { choice: r.choice, ...outcome })
  log('action_outcome', { choice: r.choice, ...outcome })
  return { choice: r.choice, confidence: r.confidence, probabilities: r.probabilities, outcome, fallback: false }
}

// ---------- director-driven triggers ----------
bus.on('offer_made', () => decideAboutDrop())
bus.on('reflect_on', (eventData) => reflect(memory.event(eventData.type, eventData.data)))

if (process.argv[1] && process.argv[1].endsWith('cinder.mjs')) {
  bus.on('log', (l) => console.log(JSON.stringify(l)))
}
