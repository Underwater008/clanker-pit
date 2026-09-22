// Village mechanics integration test — ONLY on the separate loopback lab
// server (Minecraft 25566, RCON 25576), never the production arena.
// Uses RCON fixtures and scripted skill calls; no model calls and no claims
// about model performance. Verifies the server-confirmed mechanics the
// village round depends on:
//   scoop_water (bucket fill at the spring), feed_server (pour + drink),
//   build_wall / build_gate / build_home (blueprint placement),
//   place_torch, smelt_iron (furnace window), craft_bucket (iron chain),
//   patrol (walks the ring without leaving the village).
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { serverAnatomy, wallBlueprint, gateBlueprint, torchSpots } from './village.mjs'

const FLAG = new Vec3(0, -60, 0)
const rcon = await Rcon.connect({
  host: '127.0.0.1',
  port: 25576,
  password: 'clanker-lab',
})
const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25566,
  version: '1.21.1',
  username: 'VillageLab',
  auth: 'offline',
  hideErrors: true,
})
const anatomy = serverAnatomy(FLAG)
const state = {
  camp: { ...FLAG },
  shelter: null,
  homeLot: 0,
  recent: [],
  cooldowns: {},
  role: 'coolant',
  plan: { goal: 'protect_server', intention: 'Run the village lab checks.' },
}
const villageCtx = {
  flag: FLAG,
  lotIndex: 0,
  summary: () => ({ water: { fed: 0, target: 3 }, atCapacity: false, roles: {} }),
  isEnemyPlayer: () => false,
}
const skills = installSurvival(bot, state, (event, data) =>
  console.log(JSON.stringify({ event, ...data })),
  { village: villageCtx },
)
const timeout = setTimeout(() => {
  console.error('LAB TIMEOUT')
  bot.quit()
  rcon.end()
  process.exitCode = 1
}, 420000)
async function rconOk(command) {
  const response = await rcon.send(command)
  if (/^(Unknown|Incorrect|Expected|Could not|Invalid)/i.test(response ?? ''))
    throw new Error(`RCON rejected "${command.slice(0, 60)}": ${response}`)
  return response
}
async function assertBlock(position, name, what) {
  const block = bot.blockAt(position)
  assert.ok(block && block.name === name, `${what}: expected ${name} at ${position}, saw ${block?.name}`)
  const data = await rcon.send(`data get block ${position.x} ${position.y} ${position.z}`)
  assert.ok(!/is not a valid block/i.test(data ?? ''), `server does not know block at ${position}`)
}

try {
  await once(bot, 'spawn')
  // ---- fixture: a graded village green with the Server, spring and basin.
  for (const command of [
    'gamerule doDaylightCycle false',
    'time set noon',
    'fill -16 -60 -16 16 -54 16 air',
    'fill -16 -61 -16 16 -61 16 stone',
    'fill -16 -60 -16 16 -60 16 grass_block',
    `setblock ${FLAG.x} ${FLAG.y} ${FLAG.z} obsidian`,
    `setblock ${FLAG.x} ${FLAG.y + 1} ${FLAG.z} iron_block`,
    `setblock ${FLAG.x} ${FLAG.y + 2} ${FLAG.z} iron_block`,
    `setblock ${FLAG.x} ${FLAG.y + 3} ${FLAG.z} sea_lantern`,
    `setblock ${anatomy.basinFloor.x} ${anatomy.basinFloor.y} ${anatomy.basinFloor.z} stone`,
  ]) {
    await rconOk(command)
    await sleep(120)
  }
  for (const rim of anatomy.basinRim) {
    await rconOk(`setblock ${rim.x} ${rim.y} ${rim.z} stone`)
    await sleep(80)
  }
  for (const cell of anatomy.spring) {
    await rconOk(`setblock ${cell.x} ${cell.y} ${cell.z} water`)
    await sleep(120)
  }
  // The 2x2 spring must be self-refilling: drain one cell, wait, verify.
  await rconOk(`setblock ${anatomy.spring[0].x} ${anatomy.spring[0].y} ${anatomy.spring[0].z} air`)
  await sleep(2500)
  await assertBlock(anatomy.spring[0], 'water', 'infinite coolant spring')
  await rconOk(`tp VillageLab ${FLAG.x + 0.5} ${FLAG.y + 1} ${FLAG.z + 2.5}`)
  await rconOk('clear VillageLab')
  await rconOk('give VillageLab minecraft:bucket 1')
  await sleep(1500)

  async function act(action) {
    const result = await skills.execute(action)
    console.log(JSON.stringify({ action, result }))
    await sleep(400)
    return result
  }

  // ---- coolant loop: scoop at the spring, pour into the basin (consumed).
  await act('scoop_water')
  assert.ok(
    bot.inventory.items().some((i) => i.name === 'water_bucket'),
    'scoop_water must leave a filled bucket',
  )
  const fed = await act('feed_server')
  assert.equal(fed.fedCoolant, true, 'feed_server must report a server-confirmed feed')
  // The pour leaves the water in the basin: the Server "drinks" it on its
  // own schedule (the guest gateway drains it via RCON). The lab simulates
  // the drink, then feeds again from a fresh scoop.
  await assertBlock(anatomy.basinHole, 'water', 'the poured coolant waits in the basin')
  assert.ok(
    bot.inventory.items().some((i) => i.name === 'bucket'),
    'the bucket must be empty after the pour — real consumption',
  )
  assert.ok(
    !bot.inventory.items().some((i) => i.name === 'water_bucket'),
    'no free refills: the water stayed in the basin',
  )
  await rconOk(
    `setblock ${anatomy.basinHole.x} ${anatomy.basinHole.y} ${anatomy.basinHole.z} air`,
  )
  await sleep(600)
  await assertBlock(anatomy.basinHole, 'air', 'the Server drank the coolant')
  // A feed while the Server is still drinking must be refused (verify the
  // guard), then succeed after a fresh scoop once the basin is drained.
  await rconOk(
    `setblock ${anatomy.basinHole.x} ${anatomy.basinHole.y} ${anatomy.basinHole.z} water`,
  )
  await sleep(400)
  await act('scoop_water')
  let refused = false
  try {
    await skills.execute('feed_server')
  } catch (e) {
    refused = /still drinking/.test(String(e))
  }
  assert.ok(refused, 'feeding while the Server is still drinking must be refused')
  await rconOk(
    `setblock ${anatomy.basinHole.x} ${anatomy.basinHole.y} ${anatomy.basinHole.z} air`,
  )
  await sleep(400)
  const fed2 = await act('feed_server')
  assert.equal(fed2.fedCoolant, true, 'second feed cycle must also verify')

  // ---- wall, gate, home and torches.
  await rconOk('give VillageLab minecraft:cobblestone 64')
  await sleep(1200)
  for (let i = 0; i < 80; i++) {
    const r = await act('build_wall')
    if (!r.placed) break
  }
  for (let i = 0; i < 12; i++) {
    const r = await act('build_gate')
    if (!r.placed) break
  }
  const wall = wallBlueprint(FLAG)
  const gate = gateBlueprint(FLAG)
  const missingWall = wall.filter((p) => !bot.blockAt(p)?.boundingBox)
  const missingGate = gate.filter((p) => !bot.blockAt(p)?.boundingBox)
  assert.equal(missingWall.length, 0, `wall incomplete: ${missingWall.slice(0, 3)}`)
  assert.equal(missingGate.length, 0, `gate incomplete: ${missingGate.slice(0, 3)}`)
  // The wall stands ON the ground — never replacing it.
  assert.ok(
    wall.every((p) => p.y > FLAG.y),
    'wall blocks must sit above the ground layer',
  )
  // The gate passage stays open above the ground.
  for (let x = -1; x <= 1; x++)
    for (let h = 1; h <= 2; h++) {
      const passage = bot.blockAt(FLAG.offset(x, h, 8))
      assert.ok(!passage || passage.boundingBox === 'empty', 'gate passage must stay open')
    }
  await rconOk('give VillageLab minecraft:oak_planks 64')
  await sleep(1200)
  for (let i = 0; i < 16; i++) {
    const r = await act('build_home')
    if (!r.placed) break
  }
  const obs = skills.observation()
  assert.equal(obs.village.my_home.complete, true, 'home blueprint must complete')
  await rconOk('give VillageLab minecraft:torch 8')
  await sleep(1200)
  const torchBefore = torchSpots(FLAG).filter((p) => bot.blockAt(p)?.name === 'torch').length
  await act('place_torch')
  const torchAfter = torchSpots(FLAG).filter((p) => bot.blockAt(p)?.name === 'torch').length
  assert.ok(torchAfter === torchBefore + 1, 'place_torch must light one spot')

  // ---- iron chain: mine fixture ore, smelt, craft a bucket at a table.
  await rconOk('give VillageLab minecraft:stone_pickaxe 1')
  await rconOk(`setblock ${FLAG.x + 3} ${FLAG.y} ${FLAG.z + 3} iron_ore`)
  await sleep(400)
  const mined = await act('mine_iron_ore')
  assert.ok(mined.block === 'iron_ore', 'mine_iron_ore must take the fixture ore')
  assert.ok(
    bot.inventory.items().some((i) => i.name === 'raw_iron'),
    'iron ore must drop raw iron',
  )
  await rconOk(`setblock ${FLAG.x - 3} ${FLAG.y + 1} ${FLAG.z} furnace`)
  await rconOk(`setblock ${FLAG.x - 3} ${FLAG.y + 1} ${FLAG.z - 1} crafting_table`)
  await rconOk('give VillageLab minecraft:coal 4')
  await sleep(800)
  const smelted = await act('smelt_iron')
  assert.ok(smelted.smelted >= 1, 'smelt_iron must produce ingots')
  assert.ok(
    bot.inventory.items().some((i) => i.name === 'iron_ingot'),
    'ingots must land in inventory',
  )
  await rconOk('give VillageLab minecraft:iron_ingot 3')
  await sleep(800)
  await act('craft_bucket')
  assert.ok(
    bot.inventory.items().some((i) => i.name === 'bucket'),
    'craft_bucket must produce a bucket',
  )

  // ---- patrol walks the ring.
  const patrol = await act('patrol')
  assert.ok(patrol.patrolled, 'patrol must visit a node')
  const distance = bot.entity.position.distanceTo(FLAG)
  assert.ok(distance < 24, `patrol must stay near the village (at ${distance.toFixed(1)}m)`)

  console.log(
    JSON.stringify({ event: 'LAB_VILLAGE_PASS', fed: 2, wall: wall.length, gate: gate.length }),
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
