// Isolated mechanics check: Minecraft 25566 and RCON 25576 only.
// RCON creates labeled fixtures; actions below use the same skills as clankers.
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { farmPlots, roadSpots, serverAnatomy } from './village.mjs'

const flag = new Vec3(0, -60, 0)
const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566,
  version: '1.21.1', username: 'VillageWorks', auth: 'offline', hideErrors: true })
const state = { camp: { ...flag }, shelter: null, recent: [], cooldowns: {}, role: 'farmer',
  plan: { goal: 'improve_village', intention: 'Isolated village mechanics check.' } }
const skills = installSurvival(bot, state, () => {}, { village: {
  flag, lotIndex: 0, summary: () => ({ water: { fed: 0, target: 10 }, atCapacity: false }),
  isEnemyPlayer: () => false,
} })
const timer = setTimeout(() => { console.error('LAB_TIMEOUT'); process.exit(1) }, 150000)
async function command(input) {
  const reply = await rcon.send(input)
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid)/i.test(reply ?? ''))
    throw new Error(`RCON rejected ${input}: ${reply}`)
}
async function assertBlock(p, name) {
  assert.equal(await rcon.send(`execute if block ${p.x} ${p.y} ${p.z} ${name}`),
    'Test passed', `${p} should be ${name}`)
}
try {
  await once(bot, 'spawn')
  await command('gamerule doDaylightCycle false')
  await command('time set noon')
  await command('fill -16 -60 -16 16 -54 16 air')
  await command('fill -16 -61 -16 16 -61 16 stone')
  await command('fill -16 -60 -16 16 -60 16 grass_block')
  const anatomy = serverAnatomy(flag)
  await command(`setblock ${flag.x} ${flag.y} ${flag.z} obsidian`)
  for (const p of anatomy.spring) await command(`setblock ${p.x} ${p.y} ${p.z} water`)
  await command('tp VillageWorks 0.5 -59 2.5')
  await command('clear VillageWorks')
  for (const [item, count] of [['stone_hoe', 1], ['stone_shovel', 1],
    ['wheat_seeds', 4], ['dirt', 8]])
    await command(`give VillageWorks minecraft:${item} ${count}`)
  await sleep(1000)

  const plot = farmPlots(flag)[0]
  console.log('LAB_STAGE till')
  assert.ok(skills.candidates(skills.observation()).till_farm, 'farm must be offered')
  assert.equal((await skills.execute('till_farm')).changed, 'farmland')
  await assertBlock(plot, 'farmland')
  assert.equal((await skills.execute('plant_wheat')).planted, 'wheat')
  await assertBlock(plot.offset(0, 1, 0), 'wheat')
  await command(`setblock ${plot.x} ${plot.y + 1} ${plot.z} wheat[age=7]`)
  await sleep(300)
  const harvested = await skills.execute('harvest_wheat')
  assert.ok(harvested.collected.some((item) => item.name === 'wheat'),
    'mature wheat must reach inventory')

  const road = roadSpots(flag)[0]
  console.log('LAB_STAGE road')
  assert.equal((await skills.execute('pave_road')).changed, 'dirt_path')
  await assertBlock(road, 'dirt_path')

  const hole = flag.offset(0, 0, 5)
  console.log('LAB_STAGE crater')
  await command(`setblock ${hole.x} ${hole.y} ${hole.z} air`)
  await command(`setblock ${hole.x} ${hole.y - 1} ${hole.z} air`)
  await sleep(300)
  assert.ok(skills.candidates(skills.observation()).repair_blast_hole,
    'blast damage must be offered to a clanker')
  const firstRepair = await skills.execute('repair_blast_hole')
  assert.equal(firstRepair.repairedHole, true)
  assert.ok(firstRepair.position.equals(hole.offset(0, -1, 0)))
  await assertBlock(hole.offset(0, -1, 0), 'dirt')
  const secondRepair = await skills.execute('repair_blast_hole')
  assert.equal(secondRepair.repairedHole, true)
  assert.ok(secondRepair.position.equals(hole), `repaired unexpected target ${secondRepair.position}`)
  await assertBlock(hole, 'dirt')
  console.log(JSON.stringify({ event: 'LAB_VILLAGE_IMPROVEMENTS_PASS',
    farm: true, harvest: true, road: true, repairedDepth: 2 }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  skills.stop()
  bot.quit()
  await rcon.end()
}
