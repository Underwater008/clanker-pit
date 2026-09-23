// Labeled, state-preserving round fixture. Stop the controller before running.
// node coolant-setup.mjs --source x,y,z --server-dir /path/to/server
// Backs up the selected world and bot state before changing any blocks.
import './env.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Rcon } from 'rcon-client'
import { createVillageState } from './village.mjs'
import { coolantSource, coolantCells, coolantPack } from './coolant.mjs'

const arg = (key) => process.argv[process.argv.indexOf(key) + 1]
if (!process.argv.includes('--source') || !process.argv.includes('--server-dir'))
  throw new Error('Required: --source x,y,z --server-dir /absolute/server/path')
const [x, y, z] = arg('--source').split(',').map(Number)
const serverDir = resolve(arg('--server-dir'))
const dataDir = resolve(process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state')
const village = createVillageState({ path: join(dataDir, 'village.json'), ownedKeys: ['coolantSource', 'coolantSetup'] })
if (!village.raw.flag) throw new Error('No existing village round')
const source = coolantSource(village.raw.flag, { x, y, z })
if (village.raw.coolantSource && JSON.stringify(village.raw.coolantSource) !== JSON.stringify({ x, y, z }))
  throw new Error('A different coolant spring already exists; refusing to move it implicitly')
const properties = Object.fromEntries(readFileSync(join(serverDir, 'server.properties'), 'utf8')
  .split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()]
  }))
const worldName = properties['level-name'] ?? 'world'
if (!/^[a-zA-Z0-9_-]+$/.test(worldName)) throw new Error('Unexpected selected world directory')
const rcon = await Rcon.connect({ host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(properties['rcon.port'] ?? 25575),
  password: properties['rcon.password'], timeout: 15000 })
const coords = (p) => `${p.x} ${p.y} ${p.z}`
const checked = async (command) => {
  const response = await rcon.send(command)
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid|The position is not loaded|That position is not loaded)/i.test(response))
    throw new Error(`Fixture command rejected: ${response}`)
  return response
}
const isBlock = async (p, block) => /^Test passed/.test(await checked(`execute if block ${coords(p)} minecraft:${block}`))
let savingDisabled = false
const loaded = []
try {
  // Record only a forceload owned by this setup; never remove someone else's.
  for (let cx = Math.floor((x - 2) / 16); cx <= Math.floor((x + 3) / 16); cx++)
    for (let cz = Math.floor((z - 2) / 16); cz <= Math.floor((z + 3) / 16); cz++) {
      const query = await rcon.send(`forceload query ${cx * 16} ${cz * 16}`)
      if (!query.includes('is marked for force loading')) {
        await checked(`forceload add ${cx * 16} ${cz * 16}`)
        loaded.push([cx * 16, cz * 16])
      }
    }
  if (!village.raw.coolantSource) {
    // Reject unfamiliar blocks rather than overwriting a structure.
    const allowed = ['air', 'cave_air', 'grass_block', 'dirt', 'stone', 'short_grass', 'tall_grass', 'snow', 'water']
    for (let dx = -2; dx <= 3; dx++) for (let dz = -2; dz <= 3; dz++)
      for (let dy = -1; dy <= 3; dy++) {
        const p = source.offset(dx, dy, dz)
        let ok = false
        for (const block of allowed) if (await isBlock(p, block)) { ok = true; break }
        if (!ok) throw new Error(`Spring fixture would overwrite an unfamiliar block at ${p}`)
      }
    await checked('save-off'); savingDisabled = true
    await checked('save-all flush')
    const backup = join(dirname(serverDir), 'backups', `coolant-${new Date().toISOString().replaceAll(':', '-')}`)
    mkdirSync(backup, { recursive: true })
    execFileSync('tar', ['-czf', join(backup, 'world.tar.gz'), '-C', serverDir, worldName, 'server.properties'], { timeout: 120000 })
    execFileSync('tar', ['-czf', join(backup, 'bot-state.tar.gz'), '-C', dataDir, '.'], { timeout: 30000 })
    await checked('save-on'); savingDisabled = false
    console.log(JSON.stringify({ event: 'coolant_backup', backup, world: worldName }))
    await checked(`fill ${x - 2} ${y + 1} ${z - 2} ${x + 3} ${y + 3} ${z + 3} air`)
    await checked(`fill ${x - 2} ${y - 1} ${z - 2} ${x + 3} ${y} ${z + 3} cyan_terracotta`)
    for (const p of coolantCells(source)) await checked(`setblock ${coords(p)} water`)
    for (const [dx, dz] of [[-2, -2], [3, 3]]) {
      await checked(`setblock ${x + dx} ${y + 1} ${z + dz} cyan_concrete`)
      await checked(`setblock ${x + dx} ${y + 2} ${z + dz} sea_lantern`)
    }
    const sign = { front_text: { messages: ['{"text":"CRYO COOLANT","color":"dark_aqua"}',
      '{"text":"Fill one bucket"}', '{"text":"Carry it home"}', '{"text":"Remote spring"}'] } }
    await checked(`setblock ${x - 1} ${y + 1} ${z - 2} oak_sign[rotation=8]${JSON.stringify(sign)}`)
  }
  for (const p of coolantCells(source))
    if (!await isBlock(p, 'water[level=0]')) throw new Error(`Missing coolant spring source at ${p}`)
  const packDir = join(serverDir, worldName, 'datapacks', 'clanker-coolant')
  for (const [relative, content] of Object.entries(coolantPack(village.raw.flag, source))) {
    const file = join(packDir, relative)
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content)
  }
  await checked('reload')
  const packs = await checked('datapack list enabled')
  if (!packs.includes('clanker-coolant')) throw new Error('Coolant datapack did not enable')
  village.adopt({ coolantSource: { x, y, z }, coolantSetup: { at: new Date().toISOString(), fixture: true } })
  console.log(JSON.stringify({ event: 'coolant_installed', source, distance: Math.round(Math.hypot(x - village.raw.flag.x, z - village.raw.flag.z)), packDir }))
} finally {
  if (savingDisabled) await rcon.send('save-on').catch(() => {})
  for (const [cx, cz] of loaded) await rcon.send(`forceload remove ${cx} ${cz}`).catch(() => {})
  await rcon.end()
}
