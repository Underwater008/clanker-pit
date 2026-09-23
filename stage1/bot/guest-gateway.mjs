// Guest creeper gateway: the bridge between stream viewers and the arena.
//
// Viewers join a FIFO queue (from the website, via the allowlisted public
// proxy on the telemetry port). Every 3 minutes the head of the queue
// becomes a creeper-costumed guest bot just outside the village's front
// gate. The guest's entire control set: movement (WASD on desktop, a
// left-half joystick on mobile), free look (mouse / right-half drag), jump,
// and one BOOM — which summons an ignited creeper at the guest's position:
// a real explosion that can breach the wall, and the end of that guest's
// turn. No interacting, no inventory, no sprint: nothing else.
//
// The controller (ambient.mjs) reads guest.json to merge queue status,
// guest chat, and boom events into the public telemetry snapshot, and the
// gateway serves the guest's native POV through a read-only mirror on port
// 25584 (rendered by the on-pod native-view watcher on the sixth tile).
//
// This process is a match controller, not a clanker: it may use RCON for
// placement, costume, and explosion effects (labeled audience mechanics).
import './env.mjs'
import mineflayer from 'mineflayer'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon } from 'rcon-client'
import { createNativeMirror } from './native-mirror.mjs'
import { GuestQueue, restoreGuestHistory } from './guest-queue.mjs'
import { guestCameraStatus } from './guest-camera.mjs'
import { confirmGuestExplosion } from './guest-boom.mjs'
import { readVillageFixture, serverAnatomy, VILLAGER_POOL } from './village.mjs'

const DATA_DIR = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const GUEST_PORT = Number(process.env.GUEST_PORT ?? 8090)
const MC_HOST = process.env.MC_HOST ?? '127.0.0.1'
const MC_PORT = Number(process.env.MC_PORT ?? 25565)
const RCON_PORT = Number(process.env.RCON_PORT ?? 25575)
const RCON_PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'
const MIRROR_PORT =
  Number(process.env.MIRROR_PORT_BASE ?? 25580) + Number(process.env.MIRROR_INDEX ?? 4)
const GUEST_STATE = join(DATA_DIR, 'guest.json')
const MIRROR_STATE = join(DATA_DIR, 'mirror-Guest.json')
const BOOM_GRACE_MS = 2500
const ARRIVAL_GRACE_MS = 10000
const BODY_LIMIT = 4096

mkdirSync(DATA_DIR, { recursive: true })
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

/* ---------- village fixture (read-only) ------------------------------------ */
let anatomy = null
function loadVillage() {
  const fixture = readVillageFixture(join(DATA_DIR, 'village.json'))
  anatomy = fixture ? serverAnatomy(fixture.flag) : null
}
loadVillage()
setInterval(loadVillage, 10000)

/* ---------- public snapshot ------------------------------------------------ */
let eventSeq = 0
const guestChat = []
const guestEvents = []
// Continue the id sequence across gateway restarts: the controller's
// exactly-once dedup keys (village.json) persist, so restarting at 1 would
// make fresh events collide with old keys and silently vanish.
try {
  const previous = JSON.parse(readFileSync(GUEST_STATE, 'utf8'))
  const restored = restoreGuestHistory(previous)
  eventSeq = restored.seq
  guestEvents.push(...restored.events)
  guestChat.push(...restored.chat)
  log('guest_seq_restored', { from: eventSeq })
} catch {
  eventSeq = 0
}
function emitChat(from, text) {
  guestChat.push({
    id: ++eventSeq,
    from: String(from).slice(0, 32),
    text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200),
    at: new Date().toISOString(),
  })
  if (guestChat.length > 24) guestChat.splice(0, guestChat.length - 24)
}
function emitEvent(type, data) {
  guestEvents.push({ id: ++eventSeq, type, at: new Date().toISOString(), ...data })
  if (guestEvents.length > 24) guestEvents.splice(0, guestEvents.length - 24)
}
function writeGuestState() {
  const snapshot = {
    seq: eventSeq,
    public: publicStatus(),
    chat: guestChat,
    events: guestEvents,
  }
  try {
    const tmp = `${GUEST_STATE}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot))
    renameSync(tmp, GUEST_STATE)
  } catch (e) {
    log('guest_state_error', { error: String(e) })
  }
}

function publicStatus() {
  let mirrorState = null
  try { mirrorState = JSON.parse(readFileSync(MIRROR_STATE, 'utf8')) } catch {}
  const camera = guestCameraStatus({
    active: Boolean(queue.active),
    attachedAt: guestBot ? guestMirrorAttachedAt : null,
    mirror: mirrorState,
  })
  // A mirror can attach before the player has survived placement. Only start
  // the human's turn once the guest is alive at the gate.
  camera.ready = camera.ready && Boolean(queue.active?.placed && guestBot?.isAlive)
  if (!camera.ready && camera.status === 'connected') camera.status = 'starting'
  if (camera.ready) queue.markCameraReady(queue.active?.token)
  const status = queue.status()
  const position = guestBot?.entity?.position
  if (status.active && queue.active?.placed && position &&
      [position.x, position.y, position.z].every(Number.isFinite))
    status.active.position = { x: position.x, y: position.y, z: position.z }
  return {
    ...status,
    feed: 'guest',
    gateReady: Boolean(anatomy),
    camera,
  }
}

/* ---------- rcon (audience mechanics) -------------------------------------- */
let rcon = null
async function withRcon(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!rcon) {
        rcon = await Rcon.connect({
          host: MC_HOST,
          port: RCON_PORT,
          password: RCON_PASSWORD,
          timeout: 5000,
        })
        rcon.on('error', () => {
          rcon = null
        })
        rcon.on('end', () => {
          rcon = null
        })
      }
      return await fn(rcon)
    } catch (e) {
      rcon = null
      log('rcon_error', { error: String(e).slice(0, 160), attempt })
    }
  }
  return null
}
/** Single attempt, no automatic retry: for commands where a blind retry
 * could double-execute (like the boom summon). */
async function withRconOnce(fn) {
  try {
    if (!rcon) {
      rcon = await Rcon.connect({
        host: MC_HOST,
        port: RCON_PORT,
        password: RCON_PASSWORD,
        timeout: 5000,
      })
      rcon.on('error', () => {
        rcon = null
      })
      rcon.on('end', () => {
        rcon = null
      })
    }
    return await fn(rcon)
  } catch (e) {
    rcon = null
    log('rcon_error', { error: String(e).slice(0, 160), once: true })
    return null
  }
}

/* ---------- the guest bot --------------------------------------------------- */
const queue = new GuestQueue({
  // Cryptographic tokens: Math.random output is predictable from a handful
  // of samples, and forged tokens would let a viewer steal or dequeue
  // someone else's turn.
  makeToken: () => randomUUID().replace(/-/g, ''),
  // The server is offline-mode: a guest using a cast member's name would
  // kick the real player. Villager-pool names are reserved so a guest can
  // never preempt a future boot either.
  reservedNames: [
    'ClankerCam',
    'FlagSetup',
    ...(process.env.BOT_NAMES ?? 'Cinder,Vex,Mira,Tally')
      .split(',')
      .filter(Boolean),
    ...VILLAGER_POOL,
  ],
})
const mirror = createNativeMirror({
  port: MIRROR_PORT,
  name: 'Guest',
  statePath: MIRROR_STATE,
  log: (event, data) => log(event, { component: 'guest_mirror', ...data }),
})
let guestBot = null
let guestMirrorAttachedAt = null
let boomLatched = false
const usedBotNames = new Set()

function guestSpawnPoint() {
  return anatomy?.guestSpawn ?? null
}

async function placeAtGate(botName) {
  const p = guestSpawnPoint()
  if (!p) return null
  return withRcon((client) =>
    client.send(`tp ${botName} ${p.x + 0.5} ${p.y} ${p.z + 0.5}`),
  )
}

async function wearCreeperCostume(bot) {
  // A vanilla player remains a player entity; green armor hides the default
  // body skin while the creeper head makes the guest recognizable on camera.
  const slots = [
    ['head', 'minecraft:creeper_head'],
    ['chest', 'minecraft:leather_chestplate[minecraft:dyed_color={rgb:5614165}]'],
    ['legs', 'minecraft:leather_leggings[minecraft:dyed_color={rgb:5614165}]'],
    ['feet', 'minecraft:leather_boots[minecraft:dyed_color={rgb:5614165}]'],
  ]
  for (const [slot, item] of slots) {
    const response = await withRcon((client) =>
      client.send(`item replace entity ${bot.username} armor.${slot} with ${item} 1`),
    )
    if (!response || /no entity|error|invalid|unknown/i.test(response))
      log('costume_failed', { bot: bot.username, slot, response: response ?? null })
  }
}

function teardownBot(bot, reason) {
  // Bound to the originating bot: a delayed cleanup from a finished turn
  // must never tear down the NEXT guest.
  if (guestBot === bot) guestBot = null
  if (!bot) return
  try {
    bot.quit('Turn over')
  } catch {}
  log('guest_bot_teardown', { reason })
}

function endTurn(reason, { chat = true, token = null } = {}) {
  const finished = queue.finishActive(reason, token)
  if (!finished) return null
  const nickname = finished.entry.nickname
  if (chat)
    emitChat(
      'gate',
      reason === 'boom'
        ? `${nickname} went BOOM.`
        : reason === 'died'
          ? `${nickname}'s creeper was destroyed.`
          : reason === 'left'
            ? `${nickname} slipped back into the crowd.`
            : `${nickname}'s turn ran out.`,
    )
  writeGuestState()
  return finished
}

function spawnGuest(entry) {
  // Minecraft usernames cap at 16 chars; dedupe repeat players without
  // overflowing the limit.
  let botName = entry.nickname.slice(0, 16)
  if (usedBotNames.has(botName)) {
    const suffix = `_${entry.id}`
    botName = entry.nickname.slice(0, 16 - suffix.length) + suffix
  }
  usedBotNames.add(botName)
  boomLatched = false
  entry.controls = null
  entry.placed = false // inputs and boom stay disabled until the bot is verified at the gate
  log('guest_spawn', { nickname: entry.nickname, botName })
  const bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    version: '1.21.1',
    username: botName,
    auth: 'offline',
    hideErrors: true,
    respawn: false,
    checkTimeoutInterval: 60000,
    viewDistance: 6,
  })
  // Attach before login/configuration packets and the first spawn event.
  // Attaching inside spawn misses both the initial cache and ready transition.
  guestMirrorAttachedAt = Date.now()
  mirror.attach(bot)
  guestBot = bot
  let ended = false
  let arrivalDeaths = 0
  let setupEpoch = 0
  const finish = (reason) => {
    if (ended) return
    ended = true
    endTurn(reason, { token: entry.token })
    setTimeout(() => teardownBot(bot, reason), reason === 'died' ? 3000 : 0)
  }
  bot.on('spawn', async () => {
    if (ended || queue.active?.token !== entry.token) {
      teardownBot(bot, 'stale spawn')
      return
    }
    const epoch = ++setupEpoch
    queue.markSpawned(botName, entry.token)
    log('guest_spawned', { nickname: entry.nickname, botName, position: bot.entity.position })
    // The official Minecraft client takes ~25 seconds to launch on this pod.
    // A guest can be killed by mobs before they can see or steer; protect
    // that arrival, then remove the effect shortly after the camera connects.
    const protectedAt = await withRcon((client) =>
      client.send(`effect give ${botName} minecraft:resistance 120 4 true`),
    )
    entry.arrivalProtected = Boolean(protectedAt && !/no entity|error|unknown/i.test(protectedAt))
    if (ended || setupEpoch !== epoch) return
    if (!entry.arrivalProtected) log('guest_arrival_protection_failed', { nickname: entry.nickname })
    // Place the guest at the front gate, verified. The bot spawns at world
    // spawn (outside the gate by round design), but an unverified teleport
    // could leave it near the Server core — controls and boom stay disabled
    // until the gate position is confirmed from the bot's own entity.
    const gate = guestSpawnPoint()
    for (let attempt = 1; attempt <= 3 && !ended; attempt++) {
      await placeAtGate(botName)
      await sleep(600)
      if (setupEpoch !== epoch) return
      const p = bot.entity?.position
      if (gate && p && Math.hypot(p.x - (gate.x + 0.5), p.z - (gate.z + 0.5)) < 8) {
        entry.placed = true
        break
      }
      log('gate_tp_retry', { nickname: entry.nickname, attempt, position: p ?? null })
    }
    if (ended || setupEpoch !== epoch || queue.active?.token !== entry.token) return
    if (!entry.placed) {
      log('guest_gate_refused', { nickname: entry.nickname })
      emitChat('gate', `${entry.nickname}'s creeper could not be placed at the gate. Turn skipped.`)
      finish('left')
      return
    }
    await wearCreeperCostume(bot)
    if (ended || setupEpoch !== epoch || queue.active?.token !== entry.token) return
    emitChat('gate', `${entry.nickname} became a creeper near the front gate.`)
    writeGuestState()
  })
  bot.on('death', () => {
    if (ended) return
    // Minecraft saves player data by offline username. A returning guest may
    // log in with Health:0 from their last explosion and receive a death
    // packet before Mineflayer's first spawn event. Recover that state, and
    // bounded early deaths, before the viewer's camera becomes usable.
    if (!entry.cameraReadyAt && ++arrivalDeaths <= 2) {
      setupEpoch++
      entry.placed = false
      entry.arrivalProtected = false
      log('guest_arrival_respawn', { nickname: entry.nickname, attempt: arrivalDeaths })
      bot.respawn()
      return
    }
    log('guest_died', { nickname: entry.nickname })
    finish('died')
  })
  bot.on('kicked', (reason) => {
    log('guest_kicked', { nickname: entry.nickname, reason: String(reason).slice(0, 160) })
    finish('left')
  })
  bot.on('error', (error) => log('guest_error', { error: String(error) }))
  bot.on('end', () => {
    // Natural disconnects end the turn too; teardown is idempotent.
    if (!ended && queue.active?.token === entry.token) finish('left')
    if (guestBot === bot) guestBot = null
  })
}

async function boom(entry) {
  const bot = guestBot
  if (queue.active?.token !== entry.token) return { ok: false, error: 'turn ended' }
  if (!bot?.entity) return { ok: false, error: 'no creeper body' }
  if (!entry.placed) return { ok: false, error: 'still arriving at the gate' }
  if (boomLatched) return { ok: false, error: 'already exploded' }
  boomLatched = true
  const position = {
    x: Math.round(bot.entity.position.x),
    y: Math.round(bot.entity.position.y),
    z: Math.round(bot.entity.position.z),
  }
  log('guest_boom', { nickname: entry.nickname, position })
  // Audience mechanic, match-controller side: a real creeper explosion at the
  // guest's feet. The guest dies with it — one creeper, one boom. Single
  // attempt per try (a blind retry could double-summon) and the explosion is
  // verified from a server explosion packet before it counts.
  bot.clearControlStates()
  const explodedAt = await confirmGuestExplosion({
    client: bot._client,
    position,
    summon: () => withRconOnce((client) =>
      client.send(
        `execute at ${bot.username} run summon minecraft:creeper ~ ~ ~ {NoAI:1b,ignited:1b,Fuse:15s,ExplosionRadius:3b}`,
      ),
    ),
  })
  if (!explodedAt) {
    log('boom_unverified', { nickname: entry.nickname })
    endTurn('unverified', { token: entry.token })
    teardownBot(bot, 'unverified boom')
    return { ok: false, error: 'Explosion could not be confirmed; turn ended.' }
  }
  emitEvent('boom', { nickname: entry.nickname, position: explodedAt })
  endTurn('boom', { chat: false, token: entry.token }) // controller writes the story
  writeGuestState()
  setTimeout(() => teardownBot(bot, 'boom'), BOOM_GRACE_MS)
  return { ok: true, exploded: true }
}

function applyInput(entry, input) {
  const bot = guestBot
  if (!bot || queue.active?.token !== entry.token) return false
  if (!entry.placed) return false // hold inputs while the creeper is placed at the gate
  if (boomLatched) return false
  entry.lastInputAt = Date.now()
  // The full control set a guest creeper has: move, look, jump, boom.
  // No interacting with blocks, no inventory, no sprint/sneak.
  const keys = input.keys ?? {}
  entry.controls = {
    forward: Boolean(keys.forward),
    back: Boolean(keys.back),
    left: Boolean(keys.left),
    right: Boolean(keys.right),
    jump: Boolean(keys.jump),
  }
  const c = entry.controls
  bot.setControlState('forward', c.forward)
  bot.setControlState('back', c.back)
  bot.setControlState('left', c.left)
  bot.setControlState('right', c.right)
  bot.setControlState('jump', c.jump)
  const look = input.look
  if (
    Number.isFinite(look?.yaw) &&
    Number.isFinite(look?.pitch) &&
    Math.abs(look.yaw) <= Math.PI * 8 &&
    Math.abs(look.pitch) <= Math.PI / 2 + 0.01
  ) {
    // Absolute yaw/pitch accumulated client-side; the native view's camera
    // smoothing keeps the render pan natural.
    const yaw = ((look.yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI
    bot.look(yaw, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, look.pitch)), true).catch(() => {})
  }
  return true
}

/* ---------- HTTP ----------------------------------------------------------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
}
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
function parseJsonBody(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  cors(res)
  const path = req.url?.split('?')[0]
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && path === '/status') {
      send(res, 200, { ok: true, ...publicStatus() })
      return
    }
    if (req.method === 'POST' && (path === '/join' || path === '/leave' || path === '/input')) {
      const body = parseJsonBody(await readBody(req))
      if (!body) return send(res, 400, { error: 'invalid JSON body' })
      if (path === '/join') {
        // Per-IP throttling happens at the public boundary
        // (telemetry-server.py) — behind the proxy every request arrives
        // from this host, so throttling here would throttle everyone.
        const result = queue.join(body.nickname)
        if (result.error) return send(res, 400, { error: result.error })
        log('guest_join', { nickname: result.nickname, position: result.position })
        writeGuestState()
        return send(res, 200, result)
      }
      if (path === '/leave') {
        const token = String(body.token ?? '')
        let left
        if (queue.active?.token === token) {
          const bot = guestBot
          left = Boolean(endTurn('left', { token }))
          teardownBot(bot, 'left')
        } else left = queue.leave(token)
        writeGuestState()
        return send(res, 200, { ok: left })
      }
      const entry = queue.controlsFor(String(body.token ?? ''))
      if (!entry) return send(res, 403, { error: 'not your turn' })
      if (path === '/input') {
        const applied = applyInput(entry, body)
        if (body.boom) {
          const result = await boom(entry)
          return send(res, result.ok ? 200 : 409, result)
        }
        return send(res, applied ? 200 : 409, applied ? { ok: true } : { error: 'no creeper body' })
      }
    }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    send(res, 500, { error: String(e).slice(0, 160) })
  }
})
server.listen(GUEST_PORT, '127.0.0.1', () =>
  log('gateway_up', { port: GUEST_PORT, mirror: MIRROR_PORT }),
)
server.on('error', (e) => log('gateway_error', { error: String(e) }))

/* ---------- main loop ------------------------------------------------------ */
setInterval(() => {
  const active = queue.active
  const bot = guestBot
  if (active?.cameraReadyAt && active.arrivalProtected && !active.protectionReleaseScheduled) {
    active.protectionReleaseScheduled = true
    const token = active.token
    const botName = active.botName
    setTimeout(() => {
      if (queue.active?.token !== token) return
      void withRcon((client) => client.send(`effect clear ${botName} minecraft:resistance`))
        .then((result) => log('guest_arrival_protection_ended', { nickname: active.nickname, ok: Boolean(result) }))
    }, ARRIVAL_GRACE_MS)
  }
  if (active && queue.isInputStale(active) && bot) {
    // Browser went quiet: stop the creeper instead of walking into a wall.
    active.controls = null
    for (const key of ['forward', 'back', 'left', 'right', 'jump'])
      bot.setControlState(key, false)
  }
  const transition = queue.tick()
  if (transition.spawn) {
    if (!anatomy) {
      log('spawn_refused', { reason: 'village fixture missing' })
      emitChat('gate', `${transition.spawn.nickname} was turned away — the gate is not ready yet.`)
      queue.finishActive('no-village')
      writeGuestState()
    } else spawnGuest(transition.spawn)
  }
  if (transition.end) {
    const { entry, reason } = transition.end
    log('turn_end', { nickname: entry.nickname, reason })
    if (reason === 'idle')
      emitChat('gate', `${entry.nickname}'s creeper wandered off.`)
    else emitChat('gate', `${entry.nickname}'s turn ran out.`)
    teardownBot(guestBot, 'timeout')
  }
  writeGuestState()
}, 500)
// The Server drinks its coolant (labeled match-controller mechanic): a poured
// bucket sits visibly in the cauldron until this drains it, which is what makes
// every feed genuinely consume the bot's water.
setInterval(() => {
  if (!anatomy) return
  void withRcon(async (client) => {
    const deposit = `${anatomy.deposit.x} ${anatomy.deposit.y} ${anatomy.deposit.z}`
    const base = `${anatomy.depositBase.x} ${anatomy.depositBase.y} ${anatomy.depositBase.z}`
    // Rain can leave a partial cauldron too; empty any water level. If a
    // creeper destroyed the fixture, restore only missing blocks.
    await client.send(`execute if block ${deposit} minecraft:water_cauldron run setblock ${deposit} minecraft:cauldron`)
    await client.send(`execute if block ${base} minecraft:air run setblock ${base} minecraft:stone`)
    const repaired = await client.send(`execute if block ${deposit} minecraft:air if block ${base} minecraft:stone run setblock ${deposit} minecraft:cauldron`)
    if (/^Changed the block/.test(repaired)) log('deposit_repaired', { position: anatomy.deposit })
  })
}, 20000)

function stop() {
  teardownBot(guestBot, 'shutdown')
  mirror.close()
  server.close()
  rcon?.end().catch(() => {})
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
