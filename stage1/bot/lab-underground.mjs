// No-pickaxe stone/ore pit recovery on the isolated vanilla lab only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { installSurvival } from './survival.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'UndergroundLab', auth: 'offline' })
const skills = installSurvival(bot, { camp: { x: 4, y: -57, z: 0 }, recent: [], cooldowns: {}, plan: { goal: 'explore' } },
  (event, data) => console.log(JSON.stringify({ event, ...data })))
const timer = setTimeout(() => { console.error('UNDERGROUND_LAB_TIMEOUT'); skills.stop(); bot.quit(); rcon.end(); process.exitCode = 1 }, 100000)
try {
  await once(bot, 'spawn')
  for (const command of [
    'gamemode survival UndergroundLab', 'clear UndergroundLab',
    'fill -5 -61 -5 9 -53 5 air', 'fill -4 -61 -4 8 -58 4 stone',
    'fill 0 -60 0 0 -59 0 air',
    // At the first stair landing this overhead ore used to suppress every
    // next-step candidate and let ordinary tasks walk the clanker back down.
    'setblock 1 -57 0 copper_ore', 'tp UndergroundLab 0.5 -60 0.5',
  ]) await rcon.send(command)
  await sleep(1000)
  await assert.rejects(skills.execute('explore'), /No path|NoPath|goal|deadline/i)
  const before = bot.entity.position.clone()
  for (let step = 0; step < 3; step++) {
    assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['escape_upward'], 'Recovery remains active until the surface')
    const result = await skills.execute('escape_upward')
    assert.ok(result.rose >= 0.75)
    console.log(JSON.stringify({ event: 'UPWARD_STEP_VERIFIED', step: step + 1, result }))
  }
  assert.ok(bot.entity.position.y >= -57.1, 'Must reach the remembered surface, not stop two blocks underground')
  assert.equal(bot.inventory.items().length, 0, 'Bare-hand escape must not claim stone drops or require tools')
  const server = await rcon.send('data get entity UndergroundLab Pos')
  assert.match(server, /-57\.0d/)
  assert.equal(skills.candidates(skills.observation()).escape_upward, undefined)
  console.log(JSON.stringify({ event: 'LAB_UNDERGROUND_PASS', from: before, position: bot.entity.position }))
} finally {
  clearTimeout(timer)
  skills.stop(); bot.quit(); rcon.end()
}
