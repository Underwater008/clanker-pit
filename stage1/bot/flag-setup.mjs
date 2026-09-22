// Round setup for the village scenario — a labeled fixture, not autonomous
// achievement. Run once on the pod before the controller starts:
//
//   node flag-setup.mjs
//
// It connects a probe bot, picks a flat site near world spawn, then via RCON:
// grades a village green, raises the Server monument (obsidian base, iron
// core, sea lantern), digs the coolant basin and a 2x2 infinite spring south
// of the future gate, stocks a starter chest (buckets/bread/torches), hands
// Cinder two starter buckets, and sets world spawn inside the plaza so every
// clanker and booted villager spawns around the Server.
//
// Idempotent: if bot-state/village.json already has a flag, it exits cleanly.
// The controller and gateway never trust a position that is not in this file.
import './env.mjs'
import mineflayer from 'mineflayer'
import { once } from 'node:events'
import { Vec3 } from 'vec3'
import { join } from 'node:path'
import { Rcon } from 'rcon-client'
import {
  createVillageState,
  serverAnatomy,
  WALL_RADIUS,
  WATER_TARGET,
} from './village.mjs'

const DATA_DIR = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const RCON_PORT = Number(process.env.RCON_PORT ?? 25575)
const RCON_PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'
const SEARCH_RADIUS = Number(process.env.FLAG_SITE_SEARCH ?? 48)
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

const villagePath = join(DATA_DIR, 'village.json')
const village = createVillageState({
  path: villagePath,
  ownedKeys: ['flag', 'waterTarget', 'createdAt', 'roundSetup'],
})
if (village.exists) {
  log('round_setup_skipped', { reason: 'village.json already has a flag', flag: village.raw.flag })
  process.exit(0)
}

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  version: '1.21.1',
  username: 'FlagSetup',
  auth: 'offline',
  hideErrors: true,
  respawn: false,
})
const timeout = setTimeout(() => {
  log('round_setup_timeout')
  bot.quit()
  process.exitCode = 1
}, 240000)
await once(bot, 'spawn')
log('probe_spawned', { position: bot.entity.position })

/* ---------- pick a flat, dry site near spawn ------------------------------ */
function groundHeight(x, z) {
  for (let y = 140; y >= 40; y--) {
    const block = bot.blockAt(new Vec3(x, y, z))
    if (block && block.boundingBox === 'block' && block.name !== 'water')
      return y
    if (block && block.name === 'water') return -1
  }
  return -1
}
function scoreSite(cx, cz) {
  const R = WALL_RADIUS + 1
  const heights = []
  for (let x = cx - R; x <= cx + R; x += 2)
    for (let z = cz - R; z <= cz + R; z += 2) {
      const h = groundHeight(x, z)
      if (h === -1) return null // water in the footprint
      heights.push(h)
    }
  const min = Math.min(...heights),
    max = Math.max(...heights)
  return { spread: max - min, y: Math.round((min + max) / 2) }
}
const spawn = bot.entity.position.floored()
let best = null
const offsets = [[0, 0]]
for (let r = 8; r <= SEARCH_RADIUS; r += 8)
  for (const [dx, dz] of [
    [r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r],
  ])
    offsets.push([dx, dz])
for (const [dx, dz] of offsets) {
  const candidate = scoreSite(spawn.x + dx, spawn.z + dz)
  if (!candidate) continue
  if (!best || candidate.spread < best.spread)
    best = { x: spawn.x + dx, z: spawn.z + dz, ...candidate }
  if (best.spread <= 1) break
}
if (!best) {
  log('round_setup_failed', { reason: 'no flat dry site found near spawn' })
  bot.quit()
  process.exitCode = 1
  process.exit(1)
}
const flag = new Vec3(best.x, best.y, best.z)
log('site_selected', { flag, spread: best.spread })

/* ---------- raise the fixture via RCON ------------------------------------ */
const rcon = await Rcon.connect({
  host: HOST,
  port: RCON_PORT,
  password: RCON_PASSWORD,
  timeout: 5000,
})
async function run(command) {
  const response = await rcon.send(command)
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid)/i.test(response ?? ''))
    throw new Error(`RCON rejected "${command.slice(0, 80)}": ${response}`)
  return response
}

const R = WALL_RADIUS
const a = serverAnatomy(flag)
let built = false
try {
  await run('gamerule keepInventory true')
  // Village green: solid floor, level surface, open sky over the build area.
  await run(
    `fill ${flag.x - R} ${flag.y + 1} ${flag.z - R} ${flag.x + R} ${flag.y + 9} ${flag.z + R} air`,
  )
  await run(
    `fill ${flag.x - R} ${flag.y - 1} ${flag.z - R} ${flag.x + R} ${flag.y - 1} ${flag.z + R} dirt`,
  )
  await run(
    `fill ${flag.x - R} ${flag.y} ${flag.z - R} ${flag.x + R} ${flag.y} ${flag.z + R} grass_block`,
  )
  // South road + spring + guest drop area.
  await run(
    `fill ${flag.x - 2} ${flag.y + 1} ${flag.z + R} ${flag.x + 2} ${flag.y + 6} ${flag.z + R + 6} air`,
  )
  await run(
    `fill ${flag.x - 2} ${flag.y - 1} ${flag.z + R} ${flag.x + 2} ${flag.y - 1} ${flag.z + R + 6} dirt`,
  )
  await run(
    `fill ${flag.x - 2} ${flag.y} ${flag.z + R} ${flag.x + 2} ${flag.y} ${flag.z + R + 6} grass_block`,
  )
  // The Server monument.
  await run(`setblock ${flag.x} ${flag.y} ${flag.z} obsidian`)
  await run(`setblock ${flag.x} ${flag.y + 1} ${flag.z} iron_block`)
  await run(`setblock ${flag.x} ${flag.y + 2} ${flag.z} iron_block`)
  await run(`setblock ${flag.x} ${flag.y + 3} ${flag.z} sea_lantern`)
  // Coolant basin east of the rack.
  await run(`setblock ${a.basinFloor.x} ${a.basinFloor.y} ${a.basinFloor.z} stone`)
  for (const rim of a.basinRim)
    await run(`setblock ${rim.x} ${rim.y} ${rim.z} stone`)
  // 2x2 infinite coolant spring south of the future gate.
  for (const cell of a.spring)
    await run(`setblock ${cell.x} ${cell.y} ${cell.z} water`)
  // Starter chest (fixture) with two buckets and supplies. The direct handoff
  // of Cinder's two starter buckets happens in fixture-grant.mjs once the
  // cast is actually online (flag-setup runs before the bots exist).
  await run(`setblock ${a.chest.x} ${a.chest.y} ${a.chest.z} chest`)
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.0 with minecraft:water_bucket 2`)
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.1 with minecraft:bread 8`)
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.2 with minecraft:torch 8`)
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.3 with minecraft:crafting_table 1`)
  // Future clankers, villagers and guests spawn just OUTSIDE the front gate,
  // on the south road: they arrive at the village like everyone else, and a
  // guest whose gate teleport ever fails still lands outside the wall, where
  // a boom cannot overheat the Server.
  await run(
    `setworldspawn ${flag.x} ${flag.y + 1} ${flag.z + R + 2}`,
  )
  await run(
    'say [Round setup] The Server stands at the village heart. Fixtures placed: monument, coolant basin + spring, starter chest, gate-side world spawn, keepInventory on.',
  )
  built = true
  log('fixture_built', { flag: flag.toString() })
} catch (e) {
  log('round_setup_error', {
    error: String(e),
    note: 'village.json was NOT written; fix the error and rerun node flag-setup.mjs',
  })
  process.exitCode = 1
} finally {
  await rcon.end().catch(() => {})
  bot.quit()
}

if (built) {
  village.adopt({
    flag: { x: flag.x, y: flag.y, z: flag.z },
    waterTarget: WATER_TARGET,
    createdAt: new Date().toISOString(),
    roundSetup: {
      probeSpawn: { x: spawn.x, y: spawn.y, z: spawn.z },
      siteSpread: best.spread,
      keepInventory: true,
      worldSpawnAtGate: true,
      at: new Date().toISOString(),
    },
  })
  log('round_setup_done', {
    flag: { x: flag.x, y: flag.y, z: flag.z },
    waterTarget: WATER_TARGET,
  })
}
clearTimeout(timeout)
process.exit(process.exitCode ?? 0)
