// Test-only fixtures on the isolated lab server, never the production world.
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { installSurvival, shelterBlueprint } from './survival.mjs'
import { Vec3 } from 'vec3'
const r = await Rcon.connect({
  host: '127.0.0.1',
  port: 25576,
  password: 'clanker-lab',
})
const b = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25566,
  version: '1.21.1',
  username: 'PlacementLab',
  auth: 'offline',
})
const state = {
  camp: { x: 4, y: -60, z: 5 },
  shelter: { x: 4, y: -60, z: 5 },
  recent: [],
  cooldowns: {},
  plan: { goal: 'build_shelter' },
}
const skills = installSurvival(b, state, (event, data) =>
  console.log(JSON.stringify({ event, ...data })),
)
const timer = setTimeout(() => {
  console.error('PLACEMENT_TIMEOUT')
  b.quit()
  r.end()
  process.exitCode = 1
}, 120000)
try {
  await once(b, 'spawn')
  for (const c of [
    'fill -12 -60 -12 15 -54 15 air',
    'fill -12 -61 -12 15 -61 15 grass_block',
    'fill -2 -60 -2 0 -59 0 dirt',
    'tp PlacementLab -0.5 -58 -0.5',
    'clear PlacementLab',
    'give PlacementLab oak_planks 32',
  ])
    await r.send(c)
  await sleep(1500)
  for (let i = 0; i < 12; i++)
    console.log(JSON.stringify(await skills.execute('build_shelter')))
  for (const p of shelterBlueprint(new Vec3(4, -60, 5)))
    assert.equal(
      await r.send(`execute if block ${p.x} ${p.y} ${p.z} oak_planks`),
      'Test passed',
    )
  console.log(
    JSON.stringify({
      event: 'PLACEMENT_PASS',
      serverConfirmedBlocks: 23,
      remainingPlanks: b.inventory
        .items()
        .filter((i) => i.name === 'oak_planks')
        .reduce((n, i) => n + i.count, 0),
    }),
  )
} catch (e) {
  console.error(await r.send('data get entity PlacementLab Pos'))
  console.error(await r.send('data get entity PlacementLab SelectedItem'))
  console.error(e.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  skills.stop()
  b.quit()
  await r.end()
}
