// Isolated vanilla integration test: unbreakable wall detour and dirt excavation.
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { installSurvival } from './survival.mjs'
import pathfinder from 'mineflayer-pathfinder'
const r = await Rcon.connect({
  host: '127.0.0.1',
  port: 25576,
  password: 'clanker-lab',
})
const b = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25566,
  version: '1.21.1',
  username: 'NavLab',
  auth: 'offline',
})
const skills = installSurvival(
  b,
  { camp: null, recent: [], cooldowns: {}, plan: { goal: 'explore' } },
  (event, data) => console.log(JSON.stringify({ event, ...data })),
)
const timer = setTimeout(() => {
  console.error('NAVIGATION_TIMEOUT')
  b.quit()
  r.end()
  process.exitCode = 1
}, 120000)
try {
  await once(b, 'spawn')
  const setup = async (commands) => {
    for (const c of commands) await r.send(c)
    await sleep(1500)
  }
  await setup([
    'fill -15 -60 -15 20 -55 15 air',
    'fill -15 -61 -15 20 -61 15 bedrock',
    'fill 5 -60 -3 5 -58 3 bedrock',
    'tp NavLab 0.5 -60 0.5',
  ])
  let detour = 0
  const track = () => {
    detour = Math.max(detour, Math.abs(b.entity.position.z))
  }
  b.on('physicsTick', track)
  await b.pathfinder.goto(new pathfinder.goals.GoalNearXZ(12, 0, 1))
  b.removeListener('physicsTick', track)
  assert.ok(
    b.entity.position.x > 10 && detour > 3,
    'Must walk around the unbreakable wall',
  )
  console.log(
    JSON.stringify({
      event: 'DETOUR_PASS',
      detour,
      position: b.entity.position,
    }),
  )
  await setup([
    'fill 0 -60 -1 15 -57 -1 bedrock',
    'fill 0 -60 1 15 -57 1 bedrock',
    'fill 0 -57 -1 15 -57 1 bedrock',
    'fill -1 -60 -1 -1 -57 1 bedrock',
    'fill 5 -60 0 5 -58 0 dirt',
    'tp NavLab 0.5 -60 0.5',
  ])
  let broken = 0
  const digging = (block) => {
    if (
      block.position.x === 5 &&
      block.position.z === 0 &&
      block.name === 'air'
    )
      broken++
  }
  b.on('diggingCompleted', digging)
  await b.pathfinder.goto(new pathfinder.goals.GoalNearXZ(12, 0, 1))
  assert.ok(b.entity.position.x > 10)
  const serverProof = await r.send(
    'execute if block 5 -60 0 air if block 5 -59 0 air run data get entity NavLab Pos',
  )
  assert.match(serverProof, /NavLab has the following entity data/)
  console.log(
    JSON.stringify({
      event: 'EXCAVATION_PASS',
      blocksRemoved: 2,
      diggingEvents: broken,
      serverProof,
      position: b.entity.position,
    }),
  )
} catch (e) {
  console.error(e.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  skills.stop()
  b.quit()
  await r.end()
}
