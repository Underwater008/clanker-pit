// Ambient cast v2: four contestants living in the arena, now with GOALS.
// Every GOAL_INTERVAL each bot asks Jev to pick its next activity from a
// compact, perception-filtered observation (gather wood / collect drops /
// socialize / explore / rest). Code executes the activity — models pick, code does.
// Goal changes are logged as `goal` events so the site (and logs) can answer
// "what is this bot trying to do right now?".
// Locomotion is steering-only (no pathfinder). Run ON the pod: node ambient.mjs
import './env.mjs'
import mineflayer from 'mineflayer'
import { jevChoose } from './llm.mjs'

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const GOAL_INTERVAL = Number(process.env.GOAL_INTERVAL_MS ?? 120_000)
const HOME_RADIUS = 48
const HOME = { x: 0, z: 0 } // world spawn area

const IDENTITIES = {
  Cinder: { name: 'Cinder', dispositions: ['cautious', 'industrious', 'grudge-keeping'], current_goal: 'Stockpile resources and keep the camp in sight.' },
  Vex: { name: 'Vex', dispositions: ['bold', 'opportunistic', 'restless'], current_goal: 'Get rich quick and be where the action is.' },
  Mira: { name: 'Mira', dispositions: ['methodical', 'observant', 'independent'], current_goal: 'Map the area and catalog everything useful in it.' },
  Tally: { name: 'Tally', dispositions: ['social', 'showy', 'easily bored'], current_goal: 'Stay near the others and make everything a contest.' },
}

const ACTIVITIES = {
  gather_wood: 'Chop nearby trees and collect the logs (visible forest work)',
  collect_drops: 'Walk to loose items on the ground and pick them up',
  socialize: 'Approach another contestant and hang around them',
  explore: 'Scout a new direction, staying within sight of camp',
  rest: 'Stop, look around, conserve energy',
}

const log = (bot, event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), bot, event, ...data }))

function spawnActor(name) {
  const identity = IDENTITIES[name]
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', hideErrors: true })
  let alive = false
  let activity = 'explore'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const stopWalking = () => {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
  }

  // perception filter: own state + things within 24 blocks, nothing global
  function observe() {
    const me = bot.entity
    const near = (filter) =>
      Object.values(bot.entities).filter((e) => e !== me && filter(e) && e.position.distanceTo(me.position) < 24)
    return {
      health: bot.health,
      food: bot.food,
      inventory: bot.inventory.items().map((i) => `${i.count}x ${i.name}`),
      players_nearby: near((e) => e.username).map((e) => ({ name: e.username, distance: Math.round(e.position.distanceTo(me.position)) })),
      dropped_items: near((e) => e.name === 'item').length,
      dist_from_camp: Math.round(Math.hypot(me.position.x - HOME.x, me.position.z - HOME.z)),
      current_activity: activity,
    }
  }

  async function pickGoal() {
    const observation = observe()
    const r = await jevChoose({ identity, stance: identity.current_goal, observation, questionId: 'ambient_goal', options: ACTIVITIES })
    if (r.error) {
      log(name, 'goal_fallback', { error: r.error, kept: activity })
      return
    }
    if (r.choice !== activity) {
      log(name, 'goal', { from: activity, to: r.choice, confidence: r.confidence, probabilities: r.probabilities })
      activity = r.choice
    } else {
      log(name, 'goal_kept', { activity, confidence: r.confidence })
    }
  }

  // ---- locomotion helpers (steering only) ----
  async function steerToward(pos, seconds, opts = {}) {
    const until = Date.now() + seconds * 1000
    bot.setControlState('forward', true)
    if (opts.sprint) bot.setControlState('sprint', true)
    while (Date.now() < until && alive) {
      const d = bot.entity.position.distanceTo(pos)
      if (d < (opts.stopAt ?? 2)) break
      await bot.lookAt(pos.offset(0, 1.6, 0), true)
      bot.setControlState('jump', Boolean(bot.entity?.isCollidedHorizontally))
      await sleep(120)
    }
    stopWalking()
  }

  function nearestEntity(filter, maxDist = 24) {
    const me = bot.entity
    return Object.values(bot.entities)
      .filter((e) => e !== me && filter(e))
      .map((e) => ({ e, d: e.position.distanceTo(me.position) }))
      .filter(({ d }) => d < maxDist)
      .sort((a, b) => a.d - b.d)[0]?.e ?? null
  }

  function nearestLog() {
    if (!bot.findBlock) return null
    try {
      return bot.findBlock({ matching: (b) => b.name.endsWith('_log'), maxDistance: 16, count: 1 })
    } catch { return null }
  }

  // ---- activities ----
  async function doGatherWood() {
    const block = nearestLog()
    if (!block) { await doExplore(); return }
    await steerToward(block.position, 6, { stopAt: 2.2 })
    if (alive && bot.entity.position.distanceTo(block.position) < 3.5) {
      try {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
        await bot.dig(block) // hand-punching a log: slow, visible, changes the world
        log(name, 'chopped', { block: block.name })
      } catch (e) { log(name, 'chop_failed', { error: String(e).slice(0, 80) }) }
    }
  }

  async function doCollect() {
    const item = nearestEntity((e) => e.name === 'item')
    if (!item) { await doExplore(); return }
    await steerToward(item.position, 6, { stopAt: 0.8 })
  }

  async function doSocialize() {
    const other = nearestEntity((e) => e.username && e.username !== name, 32)
    if (!other) { await doExplore(); return }
    await steerToward(other.position, 5, { stopAt: 3.5 })
    await bot.lookAt(other.position.offset(0, 1.6, 0), true)
    await sleep(1500)
  }

  async function doExplore() {
    const me = bot.entity
    // bias homeward if drifting past the camp boundary
    const distHome = Math.hypot(me.position.x - HOME.x, me.position.z - HOME.z)
    let yaw
    if (distHome > HOME_RADIUS) yaw = Math.atan2(HOME.z - me.position.z, HOME.x - me.position.x) + Math.PI / 2
    else yaw = me.yaw + (Math.random() - 0.5) * Math.PI
    const target = me.position.offset(Math.sin(yaw) * 12, 0, Math.cos(yaw) * 12)
    await steerToward(target, 4, { sprint: Math.random() < 0.2 })
  }

  async function doRest() {
    stopWalking()
    await bot.look(bot.entity.yaw + (Math.random() - 0.5), (Math.random() - 0.5) * 0.3, true)
    await sleep(2000)
  }

  const ACTORS = { gather_wood: doGatherWood, collect_drops: doCollect, socialize: doSocialize, explore: doExplore, rest: doRest }

  async function goalLoop() {
    while (alive) {
      await pickGoal().catch((e) => log(name, 'goal_error', { error: String(e).slice(0, 120) }))
      const until = Date.now() + GOAL_INTERVAL
      while (Date.now() < until && alive) {
        const actor = ACTORS[activity] ?? doExplore
        await actor().catch(() => sleep(1000))
      }
    }
  }

  bot.once('spawn', () => {
    log(name, 'spawn', { pos: bot.entity.position, identity: identity.current_goal })
    alive = true
    activity = 'explore'
    goalLoop().catch((e) => log(name, 'loop_error', { message: String(e).slice(0, 120) }))
  })
  bot.on('kicked', (r) => log(name, 'kicked', { reason: String(r).slice(0, 120) }))
  bot.on('error', (e) => log(name, 'error', { message: String(e).slice(0, 120) }))
  bot.on('end', () => {
    alive = false
    stopWalking()
    log(name, 'end', { rejoinInMs: 5000 })
    setTimeout(() => spawnActor(name), 5000)
  })
}

Object.keys(IDENTITIES).forEach((name, i) => setTimeout(() => spawnActor(name), i * 4000))
log('director', 'ambient_v2_starting', { cast: Object.keys(IDENTITIES), goalIntervalMs: GOAL_INTERVAL })
