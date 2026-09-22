// Integration test ONLY on the separate loopback lab server, never the arena.
// Uses placed test fixtures and scripted skill calls; no model calls or model-performance claims.
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { installSurvival } from './survival.mjs'
const rcon = await Rcon.connect({
  host: '127.0.0.1',
  port: 25576,
  password: 'clanker-lab',
})
const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25566,
  version: '1.21.1',
  username: 'NativeLab',
  auth: 'offline',
  hideErrors: true,
})
const state = {
  camp: { x: 0, y: -60, z: 0 },
  shelter: null,
  recent: [],
  cooldowns: {},
  plan: { goal: 'build_shelter' },
}
const skills = installSurvival(bot, state, (event, data) =>
  console.log(JSON.stringify({ event, ...data })),
)
const timeout = setTimeout(() => {
  console.error('LAB TIMEOUT')
  bot.quit()
  rcon.end()
  process.exitCode = 1
}, 300000)
try {
  await once(bot, 'spawn')
  for (const command of [
    'gamerule doDaylightCycle false',
    'time set noon',
    'fill -12 -60 -12 12 -54 12 air',
    'fill -12 -61 -12 12 -61 12 grass_block',
    'fill 4 -60 1 4 -57 1 oak_log',
    'fill 6 -60 1 6 -57 1 oak_log',
    'fill -5 -60 -3 -5 -60 3 stone',
    'tp NativeLab 0.5 -60 0.5',
    'clear NativeLab',
  ])
    await rcon.send(command)
  await sleep(2000)
  async function act(action) {
    const result = await skills.execute(action)
    console.log(
      JSON.stringify({
        action,
        result,
        inventory: bot.inventory
          .items()
          .map((i) => ({ name: i.name, count: i.count })),
      }),
    )
    await sleep(400)
  }
  for (let i = 0; i < 8; i++) await act('gather_wood')
  await act('craft_planks')
  await act('craft_planks')
  await act('craft_sticks')
  await act('craft_table')
  await act('place_table')
  await act('craft_wooden_pickaxe')
  for (let i = 0; i < 3; i++) await act('mine_stone')
  await act('craft_stone_pickaxe')
  assert.ok(bot.inventory.items().some((i) => i.name === 'stone_pickaxe'))
  for (let i = 0; i < 12; i++) await act('build_shelter')
  const observed = skills.observation()
  assert.equal(observed.shelter.complete, true)
  console.log(
    JSON.stringify({
      event: 'LAB_PASS',
      shelter: observed.shelter,
      inventory: observed.inventory,
    }),
  )
} catch (e) {
  console.error(e.stack)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  skills.stop()
  bot.quit()
  await rcon.end()
}
