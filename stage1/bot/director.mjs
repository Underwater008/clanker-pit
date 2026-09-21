// Director: runs the Stage 1 encounter protocol.
// Spawns Vex (dumb scripted actor), imports Cinder as a module, drives the phases,
// and writes a single JSONL experiment log. Run ON the pod:
//   node director.mjs             — full protocol (experimental condition)
//   CONTROL=1 node director.mjs   — control condition (Cinder runs NO_MEMORY)
import { mkdirSync, createWriteStream } from 'node:fs'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Rcon } from 'rcon-client'

const { pathfinder, Movements, goals } = pathfinderPkg
const CONTROL = process.env.CONTROL === '1'
if (CONTROL) process.env.NO_MEMORY = '1'

// Belt and braces: a prismarine-chat parse throw must not kill an experiment run.
process.on('uncaughtException', (err) => {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'uncaught_exception', error: String(err).slice(0, 300) }))
  } catch {}
})

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const RCON_PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'

const rcon = await Rcon.connect({ host: HOST, port: 25575, password: RCON_PASSWORD })
async function cmd(c) {
  const out = await rcon.send(c)
  slog({ event: 'rcon', command: c, response: out })
  return out
}

mkdirSync(new URL('./logs', import.meta.url), { recursive: true })
const runId = `${CONTROL ? 'control' : 'memory'}-${Date.now()}`
const logStream = createWriteStream(new URL(`./logs/run-${runId}.jsonl`, import.meta.url), { flags: 'a' })
const slog = (rec) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...rec })
  logStream.write(line + '\n')
  console.log(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Vex: scripted actor, no models ----
let vex
let vexResolve
const vexReady = new Promise((res) => (vexResolve = res))
let vexSpawned = false
let vexReconnects = 0
function connectVex() {
  vex = mineflayer.createBot({ host: HOST, port: PORT, username: 'Vex', auth: 'offline', hideErrors: true })
  vex.loadPlugin(pathfinder)
  vex.once('spawn', () => {
    if (!vexSpawned) { vexSpawned = true; vexResolve() }
    slog({ bot: 'vex', event: 'spawn', reconnects: vexReconnects })
  })
  vex.on('error', (e) => slog({ bot: 'vex', event: 'error', message: String(e) }))
  vex.on('kicked', (r) => slog({ bot: 'vex', event: 'kicked', reason: String(r).slice(0, 200) }))
  vex.on('end', () => {
    if (vexReconnects >= 20) { slog({ bot: 'vex', event: 'reconnect_giving_up' }); return }
    vexReconnects++
    slog({ bot: 'vex', event: 'reconnecting', attempt: vexReconnects })
    setTimeout(connectVex, 3000)
  })
}
connectVex()

async function vexGoto(x, y, z) {
  const mcData = (await import('minecraft-data')).default(vex.version)
  vex.pathfinder.setMovements(new Movements(vex, mcData))
  await vex.pathfinder.goto(new goals.GoalNear(x, y, z, 1))
}

// ---- Cinder: character module (emits logs through its bus) ----
const cinderModule = await import('./cinder.mjs')
cinderModule.bus.on('log', (l) => slog(l))
const cinderReady = new Promise((res) => cinderModule.bus.on('ready', res))

slog({ event: 'run_start', condition: CONTROL ? 'control(no memory)' : 'experimental(memory)', runId })

// Controlled arena: no mob interference during the protocol (superflat plains
// is slime country; a stray slime already invalidated one run).
// /kill SPLITS slimes into smaller ones — kill repeatedly to reach the last generation.
await cmd('gamerule doMobSpawning false')
for (let i = 0; i < 4; i++) {
  await cmd('kill @e[type=minecraft:slime]')
  await cmd('kill @e[type=minecraft:magma_cube]')
  await sleep(800)
}

await Promise.all([vexReady, cinderReady])
slog({ event: 'both_spawned' })

// Give both bots a moment to settle, then run the protocol.
await sleep(5000)

const phases = []
async function phase(name, fn) {
  slog({ event: 'phase_start', phase: name })
  const started = Date.now()
  await fn()
  phases.push({ name, durationMs: Date.now() - started })
  slog({ event: 'phase_end', phase: name })
}

// Phase 0: baseline — Vex stands neutral 6 blocks from Cinder
await phase('0_baseline', async () => {
  const cinder = Object.values(vex.entities).find((e) => e.username?.startsWith('Cinder'))
  if (!cinder) throw new Error('Cinder not visible to Vex')
  const p = cinder.position
  await vexGoto(p.x + 6, p.y, p.z)
  await sleep(8000)
})

// Phase 1: betrayal — Vex attacks Cinder once, then retreats
await phase('1_betrayal', async () => {
  const cinder = Object.values(vex.entities).find((e) => e.username?.startsWith('Cinder'))
  if (!cinder) throw new Error('Cinder not visible to Vex')
  await vexGoto(cinder.position.x, cinder.position.y, cinder.position.z)
  vex.attack(cinder)
  slog({ bot: 'vex', event: 'vex_attacked_cinder' })
  await sleep(1500)
  const away = vex.entity.position.offset(12, 0, 0)
  await vexGoto(away.x, away.y, away.z)
  slog({ bot: 'vex', event: 'vex_retreated' })
})

// Phase 2: cooldown
await phase('2_cooldown', () => sleep(60_000))

// Phase 3: the offer — Vex drops food near Cinder, then Cinder decides
await phase('3_offer', async () => {
  await cmd('give Vex minecraft:bread 4')
  await sleep(1200) // let the client's inventory catch up with the RCON give
  const food = vex.inventory.items().find((i) => i.name === 'bread')
  const cinder = Object.values(vex.entities).find((e) => e.username?.startsWith('Cinder'))
  if (!food || !cinder) {
    slog({ event: 'offer_setup_failed', hadFood: Boolean(food), sawCinder: Boolean(cinder) })
    return
  }
  await vexGoto(cinder.position.x + 3, cinder.position.y, cinder.position.z)
  await vex.tossStack(food)
  slog({ bot: 'vex', event: 'vex_dropped_food', item: food.name })
  await sleep(3000)
  cinderModule.bus.emit('offer_made')
  await sleep(20_000)
})

slog({ event: 'run_complete', phases, runId })
vex.quit()
rcon.end()
process.exit(0)
