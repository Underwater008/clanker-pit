// Isolated Minecraft regression for a tree-blocked doorway and furnace ledge.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival, rootedTreeExit } from './survival.mjs'

const port = Number(process.env.LAB_MC_PORT ?? 25568)
const rconPort = Number(process.env.LAB_RCON_PORT ?? 25578)
const rcon = await Rcon.connect({ host: '127.0.0.1', port: rconPort, password: 'clanker-route-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port, version: '1.21.1',
  username: 'RouteLab', auth: 'offline' })
const skills = installSurvival(bot,
  { camp: null, recent: [], cooldowns: {}, plan: { goal: 'explore' } },
  () => {},
  { village: { flag: new Vec3(0, -61, 0), lotIndex: 0,
    summary: () => ({}), isEnemyPlayer: () => false } })
const timer = setTimeout(() => {
  console.error('ROUTE_LAB_TIMEOUT'); skills.stop(); bot.quit(); rcon.end(); process.exitCode = 1
}, 45000)
try {
  await once(bot, 'spawn')
  for (const command of [
    'difficulty peaceful', 'time set noon',
    'fill -5 -64 -5 5 -50 5 air',
    'fill -2 -61 -2 2 -61 2 grass_block',
    'setblock 0 -61 1 dirt',
    'setblock 0 -60 1 oak_log', 'setblock 0 -59 1 oak_log', 'setblock 0 -58 1 oak_log',
    'setblock 0 -55 1 oak_leaves',
    'setblock 1 -60 0 chest',
    'setblock -1 -60 0 red_bed',
    'setblock 0 -60 -1 cobblestone',
    'tp RouteLab 0.5 -60 0.5',
  ]) await rcon.send(command)
  await sleep(600)
  console.log(JSON.stringify({ event: 'TREE_SETUP', position: bot.entity.position,
    tree: rootedTreeExit(bot), root: bot.blockAt(new Vec3(0, -61, 1))?.name,
    crown: bot.blockAt(new Vec3(0, -55, 1))?.name }))
  assert.equal(bot.blockAt(new Vec3(0, -60, 1))?.name, 'oak_log')
  assert.equal((await skills.execute('clear_tree_exit')).cleared, 2)
  await sleep(300) // Let the server process and expose the dig result to RCON.
  for (const y of [-60, -59])
    assert.match(await rcon.send(`execute if block 0 ${y} 1 air`), /^Test passed/)
  assert.match(await rcon.send('execute if block 0 -58 1 oak_log'), /^Test passed/)
  assert.match(await rcon.send('execute if block 1 -60 0 chest'), /^Test passed/)

  for (const command of [
    'fill -5 -64 -5 5 -50 5 air',
    'setblock 0 -61 0 furnace',
    'setblock -1 -62 0 grass_block',
    'tp RouteLab 0.5 -60 0.5',
  ]) await rcon.send(command)
  await sleep(600)
  assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['descend_from_perch'])
  const result = await skills.execute('descend_from_perch')
  assert.equal(result.drop, 1)
  const serverPosition = await rcon.send('data get entity RouteLab Pos')
  assert.ok(bot.entity.position.x < 0 && bot.entity.position.y <= -60.7)
  assert.match(await rcon.send('execute if block 0 -61 0 furnace'), /^Test passed/)
  console.log(JSON.stringify({ event: 'ROUTE_RECOVERY_PASS', result, serverPosition }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  skills.stop(); bot.quit(); await rcon.end()
}
