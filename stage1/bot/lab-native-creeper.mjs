// Fixed isolated ports. Verifies native mob name, collision-aware progress,
// a server-confirmed blast, and death cleanup without touching production.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { NativeCreeperDirector } from './guest-creeper.mjs'

const r = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const b = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1',
  username: 'CamAutoLab', auth: 'offline' })
let director
const booms = [], ended = [], positions = []
const deadline = setTimeout(() => { b.quit(); void r.end(); process.exitCode = 1 }, 90000)
try {
  await once(b, 'spawn')
  b.physicsEnabled = false
  for (const command of [
    'gamerule doMobSpawning false', 'difficulty normal', 'gamemode spectator CamAutoLab',
    'tp CamAutoLab 6 -50 0', 'fill -20 -60 -20 25 -54 20 air',
    'fill -20 -61 -20 25 -61 20 bedrock', 'fill 5 -60 -3 5 -58 3 bedrock',
  ]) await r.send(command)
  await b.waitForChunksToLoad()
  await sleep(700)
  director = new NativeCreeperDirector({ observer: b, send: (command) => r.send(command),
    onBoom: (entry, position) => booms.push({ nickname: entry.nickname, position }),
    onEnd: (entry, reason) => ended.push({ nickname: entry.nickname, reason }),
    log: (event, data) => console.log(JSON.stringify({ event, ...data })) })
  const anatomy = { base: { x: 12, y: -61, z: 0 }, guestSpawn: { x: 0, y: -60, z: 0 } }
  assert.equal(await director.spawn({ token: 'native-lab-1', nickname: 'MossByte' }, anatomy), true)
  const id = director.active.uuid
  assert.match(await r.send(`data get entity ${id} CustomName`), /MossByte/)
  assert.doesNotMatch(await r.send(`data get entity ${id} NoAI`), /1b/)
  const start = Date.now()
  while (Date.now() - start < 45000 && !ended.length) {
    const p = director.position()
    if (p) positions.push(p)
    await sleep(200)
  }
  assert.equal(booms.length, 1, 'Exactly one server explosion must be observed')
  assert.equal(booms[0].nickname, 'MossByte')
  assert.ok(Math.max(...positions.map((p) => Math.abs(p.z))) >= 3.3, 'Mob must detour around the wall')
  assert.ok(booms[0].position.x > 9, 'Mob must reach the Server before exploding')
  assert.match(await r.send('execute if block 5 -59 0 bedrock run data get entity CamAutoLab Pos'), /entity data/)
  assert.equal(await director.spawn({ token: 'native-lab-2', nickname: 'FuseBox' }, anatomy), true)
  await r.send(`kill ${director.active.uuid}`)
  for (let i = 0; i < 30 && director.active; i++) await sleep(100)
  assert.equal(director.active, null, 'Killed filler releases its slot')
  assert.equal(booms.length, 1, 'A killed creeper never produces a fake coolant debit')
  console.log(JSON.stringify({ event: 'NATIVE_CREEPER_LAB_PASS', namedNativeMob: true,
    confirmedExplosions: booms.length, detour: true, deathCleanup: true, samples: positions.length }))
} finally {
  clearTimeout(deadline)
  await director?.close()
  b.quit()
  await r.end()
}
