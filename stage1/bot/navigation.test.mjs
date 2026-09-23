import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import pathfinder from 'mineflayer-pathfinder'
import minecraftData from 'minecraft-data'
import { homeBed, serverAnatomy } from './village.mjs'
import {
  gotoConfirmed,
  installSurvival,
  localShelter,
  localEscapePlans,
  localEscapeReposition,
  escapeDigBudget,
  navigationReached,
  navigationGoalSummary,
  navigateWithRecovery,
  woodForTools,
  shelterBlueprint,
} from './survival.mjs'

const require = createRequire(import.meta.url)
const dependencyGoto = require('mineflayer-pathfinder/lib/goto.js')
const { GoalNearXZ } = pathfinder.goals

test('navigation watchdog logs only a compact target, never a world or live entity', () => {
  const world = { chunks: Buffer.alloc(1024 * 1024) }
  world.self = world
  const goal = { pos: new Vec3(1, 64, 2), world }
  const encoded = JSON.stringify(navigationGoalSummary(goal))
  assert.ok(encoded.length < 100)
  assert.deepEqual(JSON.parse(encoded).target, { x: 1, y: 64, z: 2 })
})

function fixture({ inventory = [], shelter = null, blocks = [], village = null } = {}) {
  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'RecoveryTest',
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    health: 20,
    food: 20,
    entities: {},
    inventory: { items: () => inventory },
    registry: minecraftData('1.21.1'),
    loadPlugin() {},
    clearControlStates() {},
    stopDigging() {},
    digTime: () => 7500,
    blockAt(position) {
      const p = position.floored()
      const defined = blocks.find((b) => b.position.equals(p))
      return defined ?? {
        position: p,
        name: p.y < 64 ? 'grass_block' : 'air',
        boundingBox: p.y < 64 ? 'block' : 'empty',
      }
    },
    findBlocks({ matching, maxDistance }) {
      return blocks.filter((b) => matching(b) &&
        b.position.distanceTo(bot.entity.position) <= maxDistance)
        .map((b) => b.position)
    },
    pathfinder: {
      setGoal() {},
      setMovements(movements) { this.movements = movements },
      async goto() {},
    },
  })
  const state = { camp: null, shelter, recent: [], cooldowns: {}, plan: { goal: 'explore' } }
  const skills = installSurvival(bot, state, () => {}, { village })
  return { bot, state, skills }
}

test('empty noPath from the pinned dependency cannot become a successful walk', async () => {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.pathfinder = {
    setGoal() {
      queueMicrotask(() => bot.emit('path_update', { path: [], status: 'noPath' }))
    },
    goto(goal) { return dependencyGoto(bot, goal) },
  }
  await assert.rejects(
    gotoConfirmed(bot, new GoalNearXZ(12, 0, 1)),
    /before reaching the goal/,
  )
  assert.equal(bot.listenerCount('path_update'), 0)
})

test('navigation succeeds only at the actual goal position', async () => {
  const { bot } = fixture()
  const goal = new GoalNearXZ(12, 0, 1)
  assert.equal(navigationReached(goal, bot.entity.position), false)
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(12.5, 64, 0.5) }
  await gotoConfirmed(bot, goal)
  assert.equal(navigationReached(goal, bot.entity.position), true)
})

test('a stalled work route sidesteps the obstacle and retries the original goal within one budget', async () => {
  const { bot } = fixture()
  const goal = new GoalNearXZ(0, -10, 1)
  const calls = []
  await navigateWithRecovery({
    bot, goal, ms: 11000, emergency: () => null, log: () => {},
    run: async (next, budget) => {
      calls.push({ next, budget })
      if (calls.length === 1) throw new Error('stuck at basin')
      bot.entity.position = new Vec3(next.x + 0.5, 64, next.z + 0.5)
    },
  })
  assert.equal(calls.length, 3)
  assert.notEqual(calls[1].next, goal)
  assert.equal(calls[2].next, goal)
  assert.ok(calls.every((c) => c.budget <= 11000))
  assert.equal(navigationReached(goal, bot.entity.position), true)
})

test('safety reflexes prevent retrying a failed work route', async () => {
  const { bot } = fixture()
  let calls = 0
  await assert.rejects(navigateWithRecovery({
    bot, goal: new GoalNearXZ(0, -10, 1), ms: 11000,
    emergency: () => 'flee', log: () => {},
    run: async () => { calls++; throw new Error('hit by threat') },
  }), /hit by threat/)
  assert.equal(calls, 1)
})

test('scouting abandons an empty failed landmark route and moves on an alternate route', async () => {
  const tree = { name: 'oak_log', boundingBox: 'block', position: new Vec3(15, 64, 0) }
  const { bot, skills } = fixture({ blocks: [tree] })
  const routes = []
  bot.pathfinder.goto = async (goal) => {
    routes.push([goal.x, goal.z])
    if (routes.length === 2) bot.entity.position = new Vec3(goal.x + 0.5, 64, goal.z + 0.5)
  }
  const result = await skills.execute('explore')
  assert.equal(routes.length, 2)
  assert.notDeepEqual(routes[0], routes[1])
  assert.ok(result.moved > 0.75)
  assert.equal(skills.observation().resources.tree, null, 'Failed landmark is temporarily excluded')
})

test('an enclosed clanker reports failed exploration rather than a fictional success', async () => {
  const { bot, skills } = fixture()
  const routes = []
  bot.pathfinder.goto = async (goal) => { routes.push(`${goal.x},${goal.z}`) }
  await assert.rejects(skills.execute('explore'), /before reaching the goal/)
  assert.equal(routes.length, 3)
  assert.equal(new Set(routes).size, 3)
  assert.deepEqual(bot.entity.position, new Vec3(0.5, 64, 0.5))
})

test('shelter construction accepts stone and all plank species without a workbench', () => {
  for (const material of ['cobblestone', 'dirt', 'cherry_planks', 'mangrove_planks']) {
    const { skills } = fixture({ inventory: [{ name: material, count: 4 }] })
    const options = skills.candidates(skills.observation())
    assert.ok(options.build_shelter, `${material} can build a shelter`)
  }
})

test('remote shelter cannot be built from afar and relocation retains its recorded site', async () => {
  const previous = { x: -103, y: 118, z: -1220 }
  const { bot, state, skills } = fixture({
    shelter: previous,
    inventory: [{ name: 'cobblestone', count: 20 }],
  })
  let routes = 0
  bot.pathfinder.goto = async () => { routes++ }
  const observation = skills.observation()
  const options = skills.candidates(observation)
  assert.equal(observation.shelter.local, false)
  assert.equal(options.build_shelter, undefined)
  assert.ok(options.relocate_shelter)
  await assert.rejects(skills.execute('build_shelter'), /too far away/)
  const result = await skills.execute('relocate_shelter')
  assert.equal(result.placed, 0)
  assert.deepEqual(state.shelterHistory[0].site, previous)
  assert.equal(localShelter(state.shelter, bot.entity.position), true)
  assert.equal(routes, 0, 'Selecting a new site does not navigate or mutate old construction')
})

test('unknown unloaded shelter blocks are reported as unknown progress', () => {
  const { bot, skills } = fixture({ shelter: { x: 1000, y: 80, z: 1000 } })
  const localBlockAt = bot.blockAt
  bot.blockAt = (p) => Math.abs(p.x) > 30 ? null : localBlockAt(p)
  const shelter = skills.observation().shelter
  assert.equal(shelter.loaded, false)
  assert.equal(shelter.blocks, null)
  assert.equal(shelter.complete, false)
})

test('navigation preserves both current and archived shelter blocks, including dirt', () => {
  const { bot, state } = fixture({ shelter: { x: 5, y: 64, z: 5 } })
  const previous = { x: -6, y: 64, z: -6 }
  state.shelterHistory = [{ site: previous }]
  bot.emit('spawn')
  const forbidden = bot.pathfinder.movements.exclusionAreasBreak[0]
  for (const origin of [state.shelter, previous]) {
    const position = shelterBlueprint(new Vec3(origin.x, origin.y, origin.z))[0]
    assert.equal(forbidden({ name: 'dirt', position }), 100)
  }
  assert.equal(forbidden({ name: 'dirt', position: new Vec3(20, 64, 20) }), 0)
})

test('village navigation does not excavate the graded floor or trample planned farmland', () => {
  const flag = new Vec3(0, 64, 0)
  const { bot } = fixture({ village: {
    flag, lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  bot.emit('spawn')
  const movements = bot.pathfinder.movements
  const forbidden = movements.exclusionAreasBreak[0]
  assert.equal(movements.maxDropDown, 1)
  assert.equal(forbidden({ name: 'dirt', position: flag.offset(1, 0, 5) }), 100)
  assert.equal(forbidden({ name: 'dirt', position: flag.offset(0, 0, 12) }), 100)
  assert.equal(forbidden({ name: 'dirt', position: flag.offset(20, 0, 20) }), 0)
  const bed = homeBed(flag, 0)
  assert.equal(forbidden({ name: 'red_bed', position: bed.foot }), 100)
  assert.equal(forbidden({ name: 'red_bed', position: bed.head }), 100)
  assert.equal(movements.exclusionAreasStep[0]({ name: 'farmland', position: flag.offset(2, 0, 12) }), 100)
})

test('returning to the village does not report success from beneath its floor', async () => {
  const flag = new Vec3(0, 63, 0)
  const { bot, skills } = fixture({ village: {
    flag, lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  bot.entity.position = new Vec3(4.5, 60, 0.5)
  bot.pathfinder.goto = async () => {} // a route that resolves without movement
  await assert.rejects(skills.execute('return_to_post'), /before reaching|no positional progress/)
})

test('resource scans preserve construction logs but still see a workbench built into a shelter', () => {
  const table = new Vec3(4, 65, 4)
  const { skills } = fixture({
    shelter: { x: 5, y: 64, z: 5 },
    blocks: [
      { name: 'oak_log', position: new Vec3(4, 64, 4), boundingBox: 'block' },
      { name: 'crafting_table', position: table, boundingBox: 'block' },
    ],
  })
  const resources = skills.observation().resources
  assert.equal(resources.tree, null)
  assert.deepEqual(resources.workbench, table)
})

test('returning to a distant camp uses a local waypoint and reports partial progress truthfully', async () => {
  const { bot, state, skills } = fixture()
  state.camp = { x: 200, y: 64, z: 0 }
  bot.pathfinder.goto = async (goal) => {
    assert.ok(goal.x < 15, 'Do not pathfind to a remote remembered position in one action')
    bot.entity.position = new Vec3(goal.x + 0.5, 64, goal.z + 0.5)
  }
  const result = await skills.execute('return_to_camp')
  assert.equal(result.returned, false)
  assert.ok(result.moved > 8)
  assert.ok(result.remaining > 150)
})

test('a distant village offers returning to post before inaccessible construction or coolant work', () => {
  const { skills } = fixture({
    inventory: [{ name: 'cobblestone', count: 20 }, { name: 'water_bucket', count: 1 }],
    village: { flag: new Vec3(200, 63, 0), lotIndex: 0, summary: () => ({}) },
  })
  const options = skills.candidates(skills.observation())
  assert.ok(options.return_to_post)
  for (const action of ['build_wall', 'build_gate', 'build_home', 'feed_server', 'build_shelter'])
    assert.equal(options[action], undefined, action)
})

test('scooping a self-refilling spring uses held-item activation and confirms the bucket inventory change', async () => {
  const flag = new Vec3(0, 63, 0)
  const inventory = [{ name: 'bucket', count: 1 }]
  const { bot, skills } = fixture({
    inventory,
    village: { flag, lotIndex: 0, summary: () => ({}) },
    blocks: serverAnatomy(flag).spring.map((position) => ({ name: 'water', boundingBox: 'empty', position })),
  })
  let uses = 0
  bot.pathfinder.goto = async (goal) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5) }
  bot.equip = async () => {}
  bot.lookAt = async () => {}
  bot._placeBlockWithOptions = async () => { assert.fail('Buckets are not block placement') }
  bot.activateItem = () => { uses++; inventory[0] = { name: 'water_bucket', count: 1 } }
  assert.deepEqual(await skills.execute('scoop_water'), { filledBucket: true })
  assert.equal(uses, 1)
  assert.equal(bot.blockAt(serverAnatomy(flag).spring[0]).name, 'water', 'Spring need not disappear to prove a filled bucket')
})

test('gathering requires an inventory gain even when the dig promise resolves', async () => {
  const logs = [{ name: 'oak_log', position: new Vec3(1, 64, 0), boundingBox: 'block' }]
  const { bot, skills } = fixture({ blocks: logs })
  bot.canDigBlock = () => true
  bot.dig = async () => { logs[0] = { ...logs[0], name: 'air', boundingBox: 'empty' } }
  await assert.rejects(skills.execute('gather_wood'), /did not deliver oak_log to inventory/)
})

test('concurrent clankers reserve different trees and report their own collected inventory', async () => {
  const logs = [1, 6].map((x) => ({ name: 'oak_log', position: new Vec3(x, 64, 0), boundingBox: 'block' }))
  const inventoryA = [], inventoryB = []
  const a = fixture({ blocks: logs, inventory: inventoryA })
  const b = fixture({ blocks: logs, inventory: inventoryB })
  let finishA, startedA
  const started = new Promise((resolve) => { startedA = resolve })
  a.bot.canDigBlock = b.bot.canDigBlock = () => true
  a.bot.dig = async () => {
    startedA()
    await new Promise((resolve) => { finishA = resolve })
    logs[0] = { ...logs[0], name: 'air', boundingBox: 'empty' }
    inventoryA.push({ name: 'oak_log', count: 1 })
  }
  b.bot.pathfinder.goto = async (goal) => { b.bot.entity.position = new Vec3(goal.x + 1, goal.y, goal.z) }
  b.bot.dig = async (block) => {
    assert.equal(block.position.x, 6, 'Second clanker must leave the first tree alone')
    logs[1] = { ...logs[1], name: 'air', boundingBox: 'empty' }
    inventoryB.push({ name: 'oak_log', count: 1 })
  }
  const gatheringA = a.skills.execute('gather_wood')
  await started
  assert.equal(b.skills.observation().resources.tree.position.x, 6)
  b.bot.entities = { 1: { name: 'item', position: new Vec3(1, 64, 0) } }
  assert.equal(b.skills.candidates(b.skills.observation()).collect_drops, undefined,
    'Generic pickup must leave another clanker’s active harvest alone')
  await assert.rejects(b.skills.execute('collect_drops'), /Drop disappeared/)
  b.bot.entities = {}
  const gatheringB = b.skills.execute('gather_wood')
  finishA()
  const [resultA, resultB] = await Promise.all([gatheringA, gatheringB])
  assert.deepEqual(resultA.collected, [{ name: 'oak_log', count: 1 }])
  assert.deepEqual(resultB.collected, [{ name: 'oak_log', count: 1 }])
})

test('village fallback protects starter wood and prioritizes the actual tool prerequisite', () => {
  const village = { flag: new Vec3(0, 63, 0), lotIndex: 0, summary: () => ({}) }
  const { state, skills } = fixture({ inventory: [{ name: 'birch_planks', count: 4 }], village })
  state.plan.goal = 'equip_tools'
  state.role = 'builder'
  const options = skills.candidates(skills.observation())
  assert.equal(Object.keys(options)[0], 'craft_table')
  assert.equal(options.build_wall, undefined)
  assert.equal(woodForTools([{ name: 'birch_planks', count: 4 }], false), 9)
})

test('builders can start a finite earth wall while continuing to seek home timber', () => {
  const village = { flag: new Vec3(0, 63, 0), lotIndex: 0, summary: () => ({ wall: { complete: false } }) }
  const tree = { position: new Vec3(12, 64, 0), name: 'oak_log', boundingBox: 'block' }
  const b = fixture({ village, blocks: [tree] })
  b.state.role = 'builder'
  const options = b.skills.candidates(b.skills.observation())
  assert.ok(options.gather_wall_earth)
  assert.ok(options.gather_wood)
  assert.ok(Object.keys(options).indexOf('gather_wood') < Object.keys(options).indexOf('gather_wall_earth'))
  const withEarth = fixture({ village, blocks: [tree], inventory: [{ name: 'dirt', count: 1 }] })
  withEarth.state.role = 'builder'
  assert.ok(withEarth.skills.candidates(withEarth.skills.observation()).build_wall)
  assert.ok(withEarth.skills.candidates(withEarth.skills.observation()).build_home)
  const completedWall = { ...village, summary: () => ({ wall: { complete: true } }) }
  const noHome = fixture({ village: completedWall })
  noHome.state.role = 'builder'
  assert.ok(noHome.skills.candidates(noHome.skills.observation()).gather_wall_earth,
    'home building must retain an earth supply after the wall is complete')
})

test('damage preempts ordinary work but does not cancel an active short water escape', async () => {
  const { bot, skills } = fixture()
  bot.entity.isInWater = true
  bot.entities = { 2: { name: 'zombie', position: new Vec3(-2, 64, 0.5) } }
  let cancelled = 0
  bot.pathfinder.setGoal = () => { cancelled++ }
  bot.emit('entityHurt', bot.entity)
  assert.equal(cancelled, 1, 'Damage must still interrupt normal work')
  bot.pathfinder.goto = async (goal) => {
    assert.ok(goal.x <= 4, 'Swimming retreat must use a reachable short target')
    bot.emit('entityHurt', bot.entity)
    assert.equal(cancelled, 1, 'Damage must not cancel the escape it just triggered')
    bot.entity.position = new Vec3(goal.x + 0.5, 64, goal.z + 0.5)
  }
  const result = await skills.execute('flee')
  assert.equal(result.retreatedFrom, 'zombie')
  const afterEscape = cancelled
  bot.emit('entityHurt', bot.entity)
  assert.equal(cancelled, afterEscape + 1, 'The exemption ends when the flee action ends')
})

test('underground recovery plans one upward stair without cutting its supporting floor', () => {
  const { bot } = fixture()
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  const plan = localEscapePlans(bot, new Vec3(4, 70, 0))[0]
  assert.deepEqual(plan.destination, new Vec3(1, 65, 0))
  assert.equal(plan.clear.length, 3)
  assert.ok(plan.clear.every((p) => p.y >= 65), 'Never dig the floor or stair support')
})

test('recovery refuses fluid pockets, falling terrain, unloaded space and construction', () => {
  const { bot } = fixture()
  const natural = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  for (const name of ['water', 'lava', 'sand', 'gravel', null]) {
    bot.blockAt = (p) => p.floored().y === 67 ? (name ? { position: p.floored(), name, boundingBox: 'block' } : null) : natural(p)
    assert.equal(localEscapePlans(bot, new Vec3(4, 70, 0)).length, 0, String(name))
  }
  bot.blockAt = natural
  assert.equal(localEscapePlans(bot, new Vec3(4, 70, 0), () => true).length, 0)
})

test('recovery can step sideways to a safe stair without digging the wet corner', () => {
  const { bot } = fixture()
  bot.blockAt = (p) => {
    const q = p.floored()
    const air = (q.x === 0 && q.z === 0 || q.x === 0 && q.z === -1) &&
      (q.y === 64 || q.y === 65)
    return { position: q, name: air ? 'air' : q.equals(new Vec3(0, 66, 0)) ? 'bedrock' : 'stone',
      boundingBox: air ? 'empty' : 'block' }
  }
  const target = new Vec3(4, 70, 0)
  assert.equal(localEscapePlans(bot, target).length, 0)
  assert.deepEqual(localEscapeReposition(bot, target), new Vec3(0, 64, -1))
  assert.ok(localEscapePlans(bot, target, () => false, new Vec3(0, 64, -1)).length)
})

test('a buried clanker can clear natural village ground as an escape hatch', async () => {
  const { bot, skills } = fixture({ village: {
    flag: new Vec3(0, 66, 0), lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  bot.entity.position = new Vec3(2.5, 64, 2.5)
  const removed = new Set()
  bot.blockAt = (p) => {
    const q = p.floored(), key = q.toString()
    const current = q.x === 2 && q.z === 2 && (q.y === 64 || q.y === 65)
    const name = removed.has(key) || current || q.y >= 67 ? 'air' :
      q.y === 66 ? 'grass_block' : q.y === 65 || q.y === 64 ? 'dirt' : 'stone'
    return { position: q, name, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  bot._client = new EventEmitter()
  bot.canDigBlock = () => true
  bot.dig = async (block) => {
    removed.add(block.position.toString())
    bot._client.emit('block_change', {
      location: block.position, type: bot.registry.blocksByName.air.minStateId,
    })
  }
  bot.pathfinder.goto = async (goal) => {
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
  }
  const result = await skills.execute('escape_upward')
  assert.equal(result.escapedUpward, true)
  assert.equal(result.cleared, 3)
  assert.equal(result.rose, 1)
  assert.ok([...removed].every((key) => !key.includes(', 67, ')))
})

test('recovery takes priority while a guard is buried under an unreachable threat, but real hurt preempts it', async () => {
  const { bot, skills, state } = fixture({ village: { flag: new Vec3(0, 70, 0), lotIndex: 0, summary: () => ({}) } })
  state.role = 'guard'
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  bot.entities = { 2: { name: 'spider', position: new Vec3(0.5, 70, 0.5) } }
  assert.equal(skills.emergency(), null)
  assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['escape_upward'])
  bot.emit('entityHurt', bot.entity)
  assert.equal(skills.emergency(), 'attack_threat')
})

test('ordinary successful navigation clears earlier failure history before recovery activates', async () => {
  const { bot, state, skills } = fixture()
  state.camp = { x: 0, y: 70, z: 0 }
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  bot.pathfinder.goto = async (goal) => { bot.entity.position = new Vec3(goal.x + 0.5, 64, goal.z + 0.5) }
  await skills.execute('explore')
  assert.equal(skills.candidates(skills.observation()).escape_upward, undefined)
})

test('stop during authoritative escape clearing cannot continue to another block or climb', async () => {
  const { bot, state, skills } = fixture()
  state.camp = { x: 4, y: 70, z: 0 }
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  bot._client = new EventEmitter()
  bot.canDigBlock = () => true
  let dug = 0
  bot.dig = async (block) => {
    dug++
    bot._client.emit('block_change', { location: block.position, type: bot.registry.blocksByName.air.minStateId })
    skills.stop()
  }
  await assert.rejects(skills.execute('escape_upward'), /interrupted/)
  assert.equal(dug, 1)
  assert.equal(bot.entity.position.y, 64)
  assert.equal(bot._client.listenerCount('block_change'), 0)
})

test('ordinary copper ore above a staircase is clearable within a bounded hand-dig budget', () => {
  const { bot } = fixture()
  bot.blockAt = (p) => ({ position: p.floored(), name: p.y === 66 ? 'copper_ore' : 'stone', boundingBox: 'block' })
  assert.ok(localEscapePlans(bot, new Vec3(4, 70, 0)).length)
  assert.equal(escapeDigBudget(15000), 17000)
  assert.equal(escapeDigBudget(16000), 18000)
  assert.throws(() => escapeDigBudget(22500), /too long/)
  assert.throws(() => escapeDigBudget(Infinity), /too long/)
})

test('a latched recovery never offers patrol or building merely because its next stair is blocked', async () => {
  const { bot, skills, state } = fixture({ village: { flag: new Vec3(0, 70, 0), lotIndex: 0, summary: () => ({}) } })
  state.role = 'guard'
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['escape_upward'])
  bot.blockAt = (p) => ({ position: p.floored(), name: 'bedrock', boundingBox: 'block' })
  assert.equal(localEscapePlans(bot, new Vec3(0, 71, 0)).length, 0)
  assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['escape_upward'])
})

test('a clanker already on an open outdoor bank clears stale underground recovery', async () => {
  const { bot, skills } = fixture({ village: {
    flag: new Vec3(0, 70, 0), lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  bot.blockAt = (p) => ({ position: p.floored(), name: 'stone', boundingBox: 'block' })
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  assert.ok(skills.candidates(skills.observation()).escape_upward)
  bot.entity.onGround = true
  bot.blockAt = (p) => ({ position: p.floored(),
    name: p.y < 64 ? 'grass_block' : 'air',
    boundingBox: p.y < 64 ? 'block' : 'empty' })
  assert.equal(skills.candidates(skills.observation()).escape_upward, undefined)
})

test('a lower outdoor bank never starts underground recovery after route failures', async () => {
  const { bot, skills } = fixture({ village: {
    flag: new Vec3(0, 70, 0), lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  bot.entity.onGround = true
  bot.pathfinder.goto = async () => { throw new Error('NoPath') }
  await assert.rejects(skills.execute('explore'), /NoPath/)
  assert.equal(skills.candidates(skills.observation()).escape_upward, undefined)
})

test('builders outside the graded village return before offering construction', () => {
  const { bot, skills, state } = fixture({ inventory: [{ name: 'cobblestone', count: 12 }],
    village: { flag: new Vec3(0, 63, 0), lotIndex: 0,
      summary: () => ({}), isEnemyPlayer: () => false } })
  state.role = 'builder'
  bot.entity.position = new Vec3(10.5, 64, 6.5)
  const options = skills.candidates(skills.observation())
  assert.ok(options.return_to_post)
  assert.equal(options.build_wall, undefined)
  assert.equal(options.repair_blast_hole, undefined)
})

test('a drowned behind a solid wall does not keep villagers fleeing', () => {
  const { bot, skills, state } = fixture({ village: {
    flag: new Vec3(0, 63, 0), lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false,
  } })
  state.role = 'farmer'
  bot.entities[2] = { id: 2, name: 'drowned', position: new Vec3(5.5, 64, 0.5) }
  const original = bot.blockAt.bind(bot)
  bot.blockAt = (p) => p.floored().equals(new Vec3(2, 65, 0))
    ? { position: p.floored(), name: 'stone', boundingBox: 'block' }
    : original(p)
  assert.equal(skills.emergency(), null)
  bot.blockAt = original
  assert.equal(skills.emergency(), 'flee')
})
