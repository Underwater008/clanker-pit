// Idempotent, labeled village fixture: place a bed in each founding home and
// set that clanker's server spawn beside it. Run after the controller has
// initialized the founding cast; never replace existing construction.
import './env.mjs'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon } from 'rcon-client'
import { homeBed } from './village.mjs'

const dataDir = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const state = JSON.parse(readFileSync(join(dataDir, 'village.json'), 'utf8'))
const marker = join(dataDir, 'home-beds.json')
if (!state.flag || state.founders?.length !== 4)
  throw new Error('Village and founding four must be initialized before placing home beds')
let previous = null
try { previous = JSON.parse(readFileSync(marker, 'utf8')) } catch {}
// The marker records an earlier installation, not the current block state.
// Trees can grow into a spawn tile later and make Minecraft fall back to the
// world spawn. Recheck the actual blocks and reset each founder's spawnpoint.

const homes = state.founders.map((name) => {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Invalid founder Minecraft name')
  const lot = state.homeLots[name]
  if (!Number.isInteger(lot)) throw new Error(`No assigned home lot for ${name}`)
  return { name, ...homeBed(state.flag, lot) }
})
const rcon = await Rcon.connect({
  host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(process.env.RCON_PORT ?? 25575),
  password: process.env.RCON_PASSWORD ?? 'clanker-dev',
  // A fresh world can take several seconds to flush its first chunks when
  // the final /save-all runs; keep the RCON response budget above that spike.
  timeout: 30000,
})
const pos = (p) => `${p.x} ${p.y} ${p.z}`
const passed = (response) => /^Test passed/.test(String(response ?? ''))
async function blockIs(p, block) {
  return passed(await rcon.send(`execute if block ${pos(p)} ${block.startsWith('#') ? block : `minecraft:${block}`}`))
}
try {
  // Inspect every site before changing any one of them. The bed occupies the
  // unused home center and doorway; the spawn tile is in the open extension.
  for (const home of homes) {
    for (const [p, part] of [[home.foot, 'foot'], [home.head, 'head']]) {
      const bed = `red_bed[facing=${home.facing},part=${part}]`
      if (!await blockIs(p, 'air') && !await blockIs(p, bed))
        throw new Error(`${home.name} bed site ${pos(p)} is occupied; no construction was replaced`)
    }
    for (const p of [home.spawn, home.spawn.offset(0, 1, 0)])
      if (!await blockIs(p, 'air') && !await blockIs(p, '#minecraft:leaves'))
        throw new Error(`${home.name} respawn tile ${pos(p)} is blocked`)
  }
  const clearedLeaves = []
  for (const home of homes) {
    for (const [p, part] of [[home.foot, 'foot'], [home.head, 'head']]) {
      const bed = `red_bed[facing=${home.facing},part=${part}]`
      if (!await blockIs(p, bed)) await rcon.send(`setblock ${pos(p)} minecraft:${bed}`)
    }
    for (const p of [home.spawn, home.spawn.offset(0, 1, 0)]) {
      if (await blockIs(p, '#minecraft:leaves')) {
        await rcon.send(`setblock ${pos(p)} minecraft:air`)
        clearedLeaves.push({ name: home.name, position: p })
      }
      if (!await blockIs(p, 'air'))
        throw new Error(`${home.name} respawn tile ${pos(p)} did not clear`)
    }
    for (const [p, part] of [[home.foot, 'foot'], [home.head, 'head']])
      if (!await blockIs(p, `red_bed[facing=${home.facing},part=${part}]`))
        throw new Error(`${home.name} bed did not persist at ${pos(p)}`)
  }
  // /spawnpoint requires an online player. Repeating it at the same location
  // is safe after a partial run, so keep no success marker until all four set.
  const pending = new Set(homes.map((home) => home.name))
  const deadline = Date.now() + 120000
  while (pending.size && Date.now() < deadline) {
    const online = String(await rcon.send('list')).replace(/^.*?:/, '')
      .split(',').map((name) => name.trim().toLowerCase())
    for (const home of homes) {
      if (!pending.has(home.name) || !online.includes(home.name.toLowerCase())) continue
      const response = await rcon.send(`spawnpoint ${home.name} ${pos(home.spawn)}`)
      if (!/^Set spawn point/i.test(String(response ?? '')))
        throw new Error(`Could not set ${home.name} spawn point: ${String(response).slice(0, 120)}`)
      pending.delete(home.name)
    }
    if (pending.size) await sleep(3000)
  }
  if (pending.size) throw new Error(`Founders not online for spawn points: ${[...pending].join(', ')}`)
  await rcon.send('save-all flush')
  const complete = { complete: true, flag: state.flag, founders: state.founders,
    installedAt: previous?.installedAt ?? new Date().toISOString(), checkedAt: new Date().toISOString() }
  writeFileSync(`${marker}.${process.pid}.tmp`, JSON.stringify(complete))
  renameSync(`${marker}.${process.pid}.tmp`, marker)
  console.log(JSON.stringify({ event: 'home_beds_ready', founders: state.founders,
    clearedLeaves, homes: homes.map(({ name, spawn }) => ({ name, spawn })) }))
} finally {
  await rcon.end().catch(() => {})
}
