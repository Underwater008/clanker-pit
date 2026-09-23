import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgressMemory, consumePlanAction } from './progress.mjs'
import { localContext, localRecoveryRoutes } from './recovery.mjs'
import { Vec3 } from 'vec3'

const p = { x: 0.5, y: 64, z: 0.5 }
test('failed attempts survive reload, block unchanged retries, and expire', () => {
  let now = 1000
  const state = {}
  let memory = createProgressMemory(state, { now: () => now })
  for (let i = 0; i < 2; i++) memory.record({ context: 'room', action: 'explore', before: p, after: p, ok: false, error: 'no path' })
  memory = createProgressMemory(JSON.parse(JSON.stringify(state)), { now: () => now })
  assert.equal(memory.blocked('room', 'explore'), true)
  assert.equal(memory.stalled('room'), true)
  assert.equal(memory.blocked('changed-room', 'explore'), false)
  assert.equal(memory.blocked('room', 'gather_wood'), false)
  now += 180001
  assert.equal(memory.blocked('room', 'explore'), false)
})

test('resolved no-op is not progress; real movement and inventory changes are', () => {
  const memory = createProgressMemory({})
  for (let i = 0; i < 2; i++) memory.record({ context: 'room', action: 'explore', before: p, after: p, ok: true })
  assert.equal(memory.stalled('room'), true)
  memory.record({ context: 'room', action: 'craft_planks', before: p, after: p, ok: true, changed: true })
  assert.equal(memory.stalled('room'), false)
  memory.record({ context: 'room', action: 'recover_walk:1:64:0', before: p, after: { ...p, x: 1.5 }, ok: true })
  assert.equal(memory.summary('room').reached_places.length, 1)
})

test('ledger remains bounded after a long blocked run', () => {
  const state = {}, memory = createProgressMemory(state)
  for (let i = 0; i < 300; i++) memory.record({ context: 'room', action: 'explore', before: p, after: p, ok: false })
  assert.equal(state.progressMemory.attempts.length, 48)
  assert.equal(memory.summary('room').failed_here.length, 8)
})

test('planner instructions are one-shot, expire, and cannot invent actions', () => {
  const plan = { issuedAt: 100, expiresAt: 200, nextAction: 'recover_walk:1:64:0' }
  const options = { [plan.nextAction]: 'east' }
  assert.equal(consumePlanAction(plan, options, null, 150).choice, plan.nextAction)
  assert.equal(consumePlanAction(plan, options, 100, 150), null)
  assert.equal(consumePlanAction(plan, {}, null, 150).reason, 'no_longer_feasible')
  assert.equal(consumePlanAction(plan, options, null, 201).reason, 'expired')
})

const flatBot = () => ({
  entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' },
  inventory: { items: () => [] },
  blockAt: (p) => ({ position: p, name: p.y < 64 ? 'stone' : 'air', stateId: p.y < 64 ? 1 : 0, boundingBox: p.y < 64 ? 'block' : 'empty' }),
})
test('recovery offers multiple inspected destinations without world mutation', () => {
  const routes = localRecoveryRoutes(flatBot())
  assert.equal(routes.length, 4)
  assert.ok(routes.every((r) => r.steps <= 5 && r.destination.y === 64))
})

test('local recovery avoids hazards and unloaded cells; sealed rooms offer no route', () => {
  const bot = flatBot(), ground = bot.blockAt
  bot.blockAt = (p) => p.x > 0 ? null : p.x < 0 ? { ...ground(p), name: 'lava' }
    : p.z !== 0 ? { ...ground(p), name: 'bedrock', boundingBox: 'block' } : ground(p)
  assert.deepEqual(localRecoveryRoutes(bot), [])
})

test('context changes after terrain, inventory, or dimension changes, not camera changes', () => {
  const bot = flatBot(), initial = localContext(bot).key
  bot.entity.yaw = 2
  assert.equal(localContext(bot).key, initial)
  bot.inventory.items = () => [{ name: 'stone_pickaxe', count: 1 }]
  assert.notEqual(localContext(bot).key, initial)
  bot.inventory.items = () => []
  bot.game.dimension = 'the_nether'
  assert.notEqual(localContext(bot).key, initial)
  bot.game.dimension = 'overworld'
  const ground = bot.blockAt
  bot.blockAt = (p) => p.x === 1 && p.y === 64 ? { ...ground(p), stateId: 2 } : ground(p)
  assert.notEqual(localContext(bot).key, initial)
})
