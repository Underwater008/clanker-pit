// Scripted concurrent harvest verification; fixed isolated lab ports only.
// RCON fixtures and scripted calls are not autonomous-model achievements.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const clients = ['HarvestLabA', 'HarvestLabB'].map((username) => {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username, auth: 'offline' })
  const skills = installSurvival(bot, { camp: null, recent: [], cooldowns: {}, plan: { goal: 'equip_tools' } },
    (event, data) => console.log(JSON.stringify({ username, event, ...data })))
  return { bot, skills, spawned: once(bot, 'spawn') }
})
const timer = setTimeout(() => {
  console.error('HARVEST_LAB_TIMEOUT')
  for (const { bot, skills } of clients) { skills.stop(); bot.quit() }
  rcon.end()
  process.exitCode = 1
}, 120000)
try {
  await Promise.all(clients.map(({ spawned }) => spawned))
  for (const command of [
    'gamerule doDaylightCycle false', 'time set noon',
    'fill -12 -60 -10 16 -53 10 air',
    'fill -12 -61 -10 16 -61 10 grass_block',
    'kill @e[type=item]',
    'fill 0 -60 0 0 -58 0 birch_log',
    'fill 8 -60 0 8 -58 0 birch_log',
    'clear HarvestLabA', 'clear HarvestLabB',
    'tp HarvestLabA 2.5 -60 2.5', 'tp HarvestLabB 3.5 -60 2.5',
  ]) await rcon.send(command)
  await sleep(1800)
  const results = await Promise.all(clients.map(({ skills }) => skills.execute('gather_wood')))
  assert.notEqual(results[0].position.x, results[1].position.x, 'Concurrent clankers must select separate trees')
  for (let i = 0; i < clients.length; i++) {
    const { bot } = clients[i], result = results[i]
    assert.ok(result.collected.some((item) => item.name === 'birch_log' && item.count >= 1))
    assert.ok(bot.inventory.items().some((item) => item.name === 'birch_log' && item.count >= 1))
    const { x, y, z } = result.position
    assert.equal(await rcon.send(`execute if block ${x} ${y} ${z} air`), 'Test passed')
    const authoritative = await rcon.send(`data get entity ${bot.username} Inventory`)
    assert.match(authoritative, /minecraft:birch_log/, 'Server must confirm the harvested item in each inventory')
    console.log(JSON.stringify({ event: 'HARVEST_VERIFIED', username: bot.username, result }))
  }
  // A raised branch must be approached at ground level, not as an impossible
  // pathfinder goal at the branch's height.
  for (const command of [
    'fill 0 -60 0 0 -58 0 air',
    'fill 8 -60 0 8 -58 0 air',
    'setblock 5 -55 2 birch_log',
    'setblock 5 -56 2 oak_leaves[persistent=true]',
    'tp HarvestLabA 2.5 -60 2.5',
  ]) await rcon.send(command)
  await sleep(600)
  assert.equal(clients[0].bot.blockAt(new Vec3(5, -56, 2)).name, 'oak_leaves')
  const raised = await clients[0].skills.execute('gather_wood')
  assert.equal(raised.position.y, -55)
  assert.ok(raised.collected.some((item) => item.name === 'birch_log'))
  assert.equal(await rcon.send('execute if block 5 -55 2 air'), 'Test passed')
  assert.equal(await rcon.send('execute if block 5 -56 2 air'), 'Test passed')
  for (const command of [
    'kill @e[type=item]',
    'setblock 7 -56 2 oak_leaves[persistent=true]',
    'setblock 7 -55 2 oak_log',
    'setblock 7 -55 2 air destroy',
  ]) await rcon.send(command)
  await sleep(600)
  const recovered = await clients[0].skills.execute('collect_drops')
  assert.ok(recovered.collected.some((item) => item.name === 'oak_log'),
    'a dropped high log must be recovered after clearing its leaf support')
  assert.equal(await rcon.send('execute if block 7 -56 2 air'), 'Test passed')
  console.log(JSON.stringify({ event: 'LAB_HARVEST_PASS', concurrentClankers: clients.length }))
} finally {
  clearTimeout(timer)
  for (const { bot, skills } of clients) { skills.stop(); bot.quit() }
  rcon.end()
}
