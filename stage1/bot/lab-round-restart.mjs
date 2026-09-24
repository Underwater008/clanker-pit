// Isolated Minecraft/RCON only; no model calls. Own six fixture cells high
// above the lab, verify they are empty before claiming them, clean up afterward.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon } from 'rcon-client'
import { createVillageState, serverAnatomy, ROUND_RESTART_MS } from './village.mjs'
import { createRoundRestarter, restoreServer } from './round-restart.mjs'

const client = await Rcon.connect({ host: '127.0.0.1', port: 25576,
  password: 'clanker-lab', timeout: 5000 })
client.on('error', () => {})
const dir = mkdtempSync(join(tmpdir(), 'clanker-round-lab-'))
const flag = { x: 1200, y: 250, z: 1200 }
const a = serverAnatomy(flag)
const cells = [a.base, ...a.core, a.lantern, a.depositBase, a.deposit]
const xyz = (p) => `${p.x} ${p.y} ${p.z}`
let owned = false, loaded = false
try {
  const response = await client.send('forceload add 1200 1200')
  assert.match(response, /^Marked chunk/, 'lab chunk must not belong to another test')
  loaded = true
  await sleep(1500)
  for (const p of cells)
    assert.match(await client.send(`execute if block ${xyz(p)} minecraft:air`), /^Test passed/)
  owned = true
  let time = Date.now()
  const path = join(dir, 'village.json')
  const load = () => createVillageState({ path, now: () => time })
  let village = load()
  village.adopt({ flag, waterFed: 10, population: ['Cinder'], founders: ['Cinder'], homeLots: { Cinder: 0 } })
  await restoreServer(client, flag)
  village.overheat('event:lab-1')
  assert.equal(village.snapshot().round.phase, 'active')
  assert.equal(village.overheat('event:lab-2', { nickname: 'RoundLab' }).destroyed, true)
  // Simulate blast damage only to our fixture cells. This lab validates
  // confirmed-event handling + restoration, not the explosion detector.
  await client.send(`setblock ${xyz(a.lantern)} air`)
  await client.send(`setblock ${xyz(a.core[0])} water`)
  village = load() // Controller process restart during the countdown.
  time += ROUND_RESTART_MS
  let completions = 0
  const tick = createRoundRestarter({ village, now: () => time,
    restore: (f) => restoreServer(client, f), onRestart: () => completions++ })
  await tick()
  assert.equal(completions, 1)
  assert.equal(village.snapshot().round.number, 2)
  assert.equal(village.raw.waterFed, 10)
  assert.match(await client.send(`execute if block ${xyz(a.lantern)} sea_lantern`), /^Test passed/)
  assert.match(await client.send(`execute if block ${xyz(a.core[0])} iron_block`), /^Test passed/)
  assert.equal(village.overheat('event:lab-2'), null)
  await tick()
  assert.equal(completions, 1)
  assert.deepEqual(village.raw.population, ['Cinder'])
  console.log(JSON.stringify({ event: 'ROUND_RESTART_LAB_PASS', round: 2,
    coolant: 10, serverConfirmedFixture: true, resumedAfterReload: true, duplicateIgnored: true }))
} finally {
  try {
    if (owned) for (const p of cells) await client.send(`setblock ${xyz(p)} air`)
    if (loaded) await client.send('forceload remove 1200 1200')
  } finally {
    await client.end()
    rmSync(dir, { recursive: true, force: true })
  }
}
