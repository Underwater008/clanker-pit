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
import { mkdirSync, readFileSync } from 'node:fs'
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
const MAX_SITE_SPREAD = Number(process.env.FLAG_SITE_MAX_SPREAD ?? 3)
if (!Number.isFinite(SEARCH_RADIUS) || SEARCH_RADIUS < 8 || SEARCH_RADIUS > 128 ||
    !Number.isFinite(MAX_SITE_SPREAD) || MAX_SITE_SPREAD < 0 || MAX_SITE_SPREAD > 6)
  throw new Error('Flag site search radius must be 8..128 and max spread 0..6')
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

mkdirSync(DATA_DIR, { recursive: true })
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
let chunksDeadline
try {
  await Promise.race([
    bot.waitForChunksToLoad(),
    new Promise((_, reject) => { chunksDeadline = setTimeout(() => reject(new Error('nearby chunks did not load within 30 seconds')), 30000) }),
  ])
  log('probe_chunks_ready')
} catch (e) {
  log('round_setup_failed', { reason: String(e) })
  bot.quit()
  clearTimeout(timeout)
  process.exit(1)
} finally {
  clearTimeout(chunksDeadline)
}

/* ---------- pick a flat, dry site near spawn ------------------------------ */
const heightCache = new Map()
function groundHeight(x, z) {
  const key = `${x},${z}`
  if (heightCache.has(key)) return heightCache.get(key)
  const minY = bot.game.minY ?? -64
  const topY = minY + (bot.game.height ?? 384) - 1
  let height = -Infinity
  for (let y = topY; y >= minY; y--) {
    const block = bot.blockAt(new Vec3(x, y, z))
    // An unknown column is not evidence of solid land. A canopy is not a
    // foundation either: keep the fixture out of trees, water and lava.
    if (!block || /^(water|lava)$/.test(block.name)) break
    if (block.boundingBox !== 'block') continue
    if (/(?:_leaves|_log|_wood)$/.test(block.name)) break
    height = y
    break
  }
  heightCache.set(key, height)
  return height
}
function scoreSite(cx, cz) {
  const R = WALL_RADIUS + 1
  const heights = []
  // Check every column, including the spring and guest arrival road. Sampling
  // every second column missed narrow water channels inside the foundation.
  for (let x = cx - R; x <= cx + R; x++)
    for (let z = cz - R; z <= cz + R; z++) heights.push(groundHeight(x, z))
  for (let x = cx - 2; x <= cx + 2; x++)
    for (let z = cz + WALL_RADIUS; z <= cz + WALL_RADIUS + 6; z++) heights.push(groundHeight(x, z))
  if (heights.some((h) => !Number.isFinite(h))) return null
  const min = Math.min(...heights), max = Math.max(...heights)
  if (max - min > MAX_SITE_SPREAD) return null
  return { spread: max - min, minY: min, y: Math.round((min + max) / 2) }
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
  log('round_setup_failed', { reason: 'no loaded, dry site within the allowed elevation spread near spawn', searchRadius: SEARCH_RADIUS, maxSpread: MAX_SITE_SPREAD })
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
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid|The position is not loaded|That position is not loaded|No player was found)|can only stack up to/i.test(response ?? ''))
    throw new Error(`RCON rejected "${command.slice(0, 80)}": ${response}`)
  return response
}

const R = WALL_RADIUS
const a = serverAnatomy(flag)
let built = false
try {
  await run('gamerule keepInventory true')
  await run('gamerule spawnRadius 0')
  // Village green: solid floor, level surface, open sky over the build area.
  await run(
    `fill ${flag.x - R} ${flag.y + 1} ${flag.z - R} ${flag.x + R} ${flag.y + 9} ${flag.z + R} air`,
  )
  await run(
    `fill ${flag.x - R} ${Math.min(best.minY, flag.y - 1)} ${flag.z - R} ${flag.x + R} ${flag.y - 1} ${flag.z + R} dirt`,
  )
  await run(
    `fill ${flag.x - R} ${flag.y} ${flag.z - R} ${flag.x + R} ${flag.y} ${flag.z + R} grass_block`,
  )
  // South road + spring + guest drop area.
  await run(
    `fill ${flag.x - 2} ${flag.y + 1} ${flag.z + R} ${flag.x + 2} ${flag.y + 6} ${flag.z + R + 6} air`,
  )
  await run(
    `fill ${flag.x - 2} ${Math.min(best.minY, flag.y - 1)} ${flag.z + R} ${flag.x + 2} ${flag.y - 1} ${flag.z + R + 6} dirt`,
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
  // Filled buckets do not stack; one slot per bucket.
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.0 with minecraft:water_bucket 1`)
  await run(`item replace block ${a.chest.x} ${a.chest.y} ${a.chest.z} container.4 with minecraft:water_bucket 1`)
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
  // Verify authoritative block state before recording the fixture as ready.
  for (const [position, block] of [
    [a.base, 'obsidian'], ...a.core.map((p) => [p, 'iron_block']),
    [a.lantern, 'sea_lantern'], [a.basinFloor, 'stone'],
    ...a.spring.map((p) => [p, 'water[level=0]']),
  ]) {
    const response = await run(`execute if block ${position.x} ${position.y} ${position.z} minecraft:${block}`)
    if (!/^Test passed/.test(response)) throw new Error(`Fixture verification failed at ${position}: ${response}`)
  }
  const chestItems = await run(`data get block ${a.chest.x} ${a.chest.y} ${a.chest.z} Items`)
  if ((chestItems.match(/minecraft:water_bucket/g) ?? []).length !== 2)
    throw new Error('Starter chest does not contain both water buckets')
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
      spawnRadius: 0,
      worldSpawnAtGate: true,
      at: new Date().toISOString(),
    },
  })
  const persisted = JSON.parse(readFileSync(villagePath, 'utf8'))
  if (village.saveFailures || !persisted.flag || ['x', 'y', 'z'].some((key) => persisted.flag[key] !== flag[key]))
    throw new Error('Fixture blocks exist, but village.json was not persisted correctly; inspect state before retrying')
  log('round_setup_done', {
    flag: { x: flag.x, y: flag.y, z: flag.z },
    waterTarget: WATER_TARGET,
  })
}
clearTimeout(timeout)
process.exit(process.exitCode ?? 0)
