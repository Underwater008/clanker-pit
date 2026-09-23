// Scripted mechanics verification ONLY on Minecraft 25566 / RCON 25576.
// This creates an isolated flat route, spring and inventory fixtures; no models.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { isCoolantBucket } from './coolant.mjs'
import { homeBlueprint, homeLot } from './village.mjs'

const serverDir = process.env.LAB_SERVER_DIR
if (!serverDir || !/^server-port=25566$/m.test(readFileSync(join(serverDir, 'server.properties'), 'utf8')) ||
    !/^rcon.port=25576$/m.test(readFileSync(join(serverDir, 'server.properties'), 'utf8')))
  throw new Error('LAB_SERVER_DIR must select the isolated server on 25566/25576')
const flag = new Vec3(0, -60, 0), source = { x: 0, y: -60, z: 120 }
const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1',
  username: 'CoolantLab', auth: 'offline', hideErrors: true })
const timer = setTimeout(() => { console.error('LAB_TIMEOUT'); process.exit(1) }, 300000)
const state = { camp: { ...flag }, shelter: null, recent: [], cooldowns: {}, role: 'coolant', plan: { goal: 'protect_server' } }
const skills = installSurvival(bot, state, (event, data) => console.log(JSON.stringify({ event, ...data })), { village: {
  flag, lotIndex: 0, coolantSource: source, summary: () => ({ atCapacity: false }), isEnemyPlayer: () => false,
} })
async function command(input) {
  const response = await rcon.send(input)
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid)/i.test(response)) throw new Error(response)
  return response
}
try {
  await once(bot, 'spawn')
  await command('difficulty peaceful')
  await command('gamerule doDaylightCycle false')
  await command('time set noon')
  await command('forceload add -8 -10 8 135')
  await sleep(1000)
  await command('fill -8 -59 -10 8 -54 135 air')
  await command('fill -8 -61 -10 8 -60 135 grass_block')
  await command('setblock 2 -60 0 stone')
  await command('setblock 2 -59 0 cauldron')
  await command('tp CoolantLab 0.5 -59 3.5')
  await command('clear CoolantLab')
  const dataDir = join(serverDir, 'coolant-lab-state')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'village.json'), JSON.stringify({ flag, population: [], waterFed: 7 }))
  const setup = await promisify(execFile)(process.execPath,
    [new URL('./coolant-setup.mjs', import.meta.url).pathname, '--source', '0,-60,120', '--server-dir', serverDir],
    { env: { ...process.env, BOT_DATA_DIR: dataDir }, timeout: 60000 })
  console.log(setup.stdout)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'village.json'))).waterFed, 7)
  await command('give CoolantLab water_bucket 1')
  await sleep(500)
  await assert.rejects(skills.execute('feed_server'), /No eligible coolant/)
  assert.deepEqual(await skills.execute('empty_ordinary_water'), { disposedOrdinaryWater: true })
  await command('setblock 2 -59 0 cauldron')
  await command('give CoolantLab bucket 1') // two empties test single-bucket splitting
  await sleep(500)
  for (let i = 0; i < 20 && bot.entity.position.distanceTo(new Vec3(0, -60, 120)) > 5; i++) {
    assert.ok(skills.candidates(skills.observation()).travel_to_coolant)
    const result = await skills.execute('travel_to_coolant')
    assert.ok(result.moved > 0)
    console.log(JSON.stringify({ event: 'lab_outbound', ...result }))
  }
  assert.ok(bot.entity.position.distanceTo(new Vec3(0, -60, 120)) <= 5)
  // Carrying a full ordinary bucket through the refinery does not tag it.
  await command('give CoolantLab water_bucket 1')
  await sleep(500)
  assert.equal(bot.inventory.items().filter(isCoolantBucket).length, 0)
  assert.equal((await skills.execute('scoop_water')).filledBucket, true)
  const coolant = bot.inventory.items().find(isCoolantBucket)
  assert.ok(coolant, JSON.stringify(bot.inventory.items().filter((i) => i.name === 'water_bucket')))
  assert.equal(bot.inventory.items().filter(isCoolantBucket).length, 1)
  assert.ok(skills.candidates(skills.observation()).return_to_post)
  for (let i = 0; i < 20 && bot.entity.position.distanceTo(flag) > 6; i++)
    await skills.execute('return_to_post')
  assert.ok(bot.entity.position.distanceTo(flag) <= 6)
  assert.equal((await skills.execute('feed_server')).fedCoolant, true)
  assert.equal(await command('execute if block 2 -59 0 water_cauldron'), 'Test passed')
  assert.equal(bot.inventory.items().filter(isCoolantBucket).length, 0)
  await command('setblock 2 -59 0 cauldron')
  await assert.rejects(skills.execute('feed_server'), /No eligible coolant/)
  // Real crafting and equipment-slot update, not just an offered action.
  await command('setblock 0 -59 3 crafting_table')
  await command('give CoolantLab iron_ingot 10')
  await command('give CoolantLab stick 1')
  await sleep(400)
  await skills.execute('craft_iron_sword')
  await skills.execute('craft_iron_chestplate')
  assert.equal((await skills.execute('equip_armor')).equipped, 'iron_chestplate')
  const chest = await command('data get entity CoolantLab Inventory')
  assert.match(chest, /iron_chestplate/)
  const home = homeBlueprint(homeLot(flag, 0), flag), leaf = home[0]
  for (const p of home) await command(`setblock ${p.x} ${p.y} ${p.z} cobblestone`)
  await command(`setblock ${leaf.x} ${leaf.y} ${leaf.z} oak_leaves[persistent=true]`)
  await command('give CoolantLab cobblestone 4')
  await sleep(300)
  assert.equal(skills.observation().village.my_home.complete, false)
  assert.equal((await skills.execute('build_home')).placed, 1)
  assert.equal(await command(`execute if block ${leaf.x} ${leaf.y} ${leaf.z} cobblestone`), 'Test passed')
  console.log(JSON.stringify({ event: 'LAB_PASS', distance: 120, roundTrip: true,
    ordinaryRejected: true, coolantDepositConfirmed: true, ironCraftedAndWorn: true, leafReplacedWithMasonry: true }))
} finally {
  clearTimeout(timer); skills.stop(); bot.quit()
  await rcon.send('forceload remove -8 -10 8 135').catch(() => {})
  await rcon.end()
}
