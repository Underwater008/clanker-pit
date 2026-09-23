// Isolated 25576 regression for the round's damaged coolant source.
import assert from 'node:assert/strict'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { repairSpring } from './spring-repair.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const spring = [new Vec3(80, -61, 80), new Vec3(81, -61, 80),
  new Vec3(80, -61, 81), new Vec3(81, -61, 81)]
try {
  await rcon.send('forceload add 80 80')
  await rcon.send('fill 78 -62 78 83 -58 83 air')
  const first = await repairSpring(rcon, { spring })
  assert.equal(first, 20, 'four supports, twelve bank blocks and four sources')
  for (const cell of spring)
    assert.match(await rcon.send(`execute if block ${cell.x} ${cell.y} ${cell.z} minecraft:water[level=0]`), /^Test passed/)
  assert.equal(await repairSpring(rcon, { spring }), 0, 'an intact spring is unchanged')
  console.log(JSON.stringify({ event: 'SPRING_REPAIR_PASS', restored: first }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  await rcon.send('forceload remove 80 80').catch(() => {})
  await rcon.end()
}
