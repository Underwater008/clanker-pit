// Isolated 25566/25576 regression: a clanker stranded on a high table walks
// off to an inspected landing and the table remains intact.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1',
  username: 'PerchLab', auth: 'offline' })
const skills = installSurvival(bot,
  { camp: null, recent: [], cooldowns: {}, plan: { goal: 'explore' } },
  (event, data) => console.log(JSON.stringify({ event, ...data })),
  { village: { flag: new Vec3(0, -61, 0), lotIndex: 0,
    summary: () => ({}), isEnemyPlayer: () => false } })
const timer = setTimeout(() => {
  console.error('PERCH_LAB_TIMEOUT'); skills.stop(); bot.quit(); rcon.end(); process.exitCode = 1
}, 30000)
try {
  await once(bot, 'spawn')
  for (const command of [
    'difficulty peaceful', 'time set noon',
    'fill -4 -60 -4 4 -52 4 air',
    'fill -4 -61 -4 4 -61 4 grass_block',
    'setblock 0 -54 0 crafting_table',
    'tp PerchLab 0.5 -53 0.5',
  ]) await rcon.send(command)
  await sleep(600)
  assert.equal(bot.entity.position.y, -53)
  assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['descend_from_perch'])
  const result = await skills.execute('descend_from_perch')
  const serverPosition = await rcon.send('data get entity PerchLab Pos')
  assert.ok(bot.entity.position.y <= -59.7 && bot.entity.position.y >= -60.3)
  assert.match(serverPosition, /PerchLab has the following entity data/)
  assert.match(await rcon.send('execute if block 0 -54 0 crafting_table'), /^Test passed/)
  console.log(JSON.stringify({ event: 'PERCH_DESCENT_PASS', result, serverPosition }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  skills.stop(); bot.quit(); await rcon.end()
}
