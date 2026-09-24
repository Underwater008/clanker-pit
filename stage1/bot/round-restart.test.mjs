import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVillageState, ROUND_RESTART_MS } from './village.mjs'
import { createRoundRestarter, restoreServer } from './round-restart.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'round-restart-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let time = Date.parse('2026-09-23T00:00:00Z')
  const path = join(dir, 'village.json')
  const load = () => createVillageState({ path, now: () => time })
  const village = load()
  village.adopt({ flag: { x: 0, y: 64, z: 0 }, waterFed: 10,
    createdAt: new Date(time).toISOString(), population: ['Cinder', 'Ember'],
    founders: ['Cinder'], homeLots: { Cinder: 0, Ember: 1 }, roles: { Cinder: 'coolant' } })
  return { village, path, load, now: () => time, advance: (ms) => { time += ms } }
}

test('zero is vulnerable; only the next distinct blast wins, once across reloads', (t) => {
  const { village, load, advance } = fixture(t)
  assert.deepEqual(village.overheat('event:1'), { before: 10, after: 0, changed: true })
  assert.equal(village.snapshot().round.phase, 'active')
  assert.equal(village.overheat('event:1'), null)
  assert.equal(village.overheat('event:2', { nickname: 'Xiao' }).destroyed, true)
  const down = village.snapshot().round
  assert.equal(down.number, 1)
  assert.equal(down.winner, 'Xiao')
  assert.equal(village.feedCoolant('Cinder'), null)
  assert.equal(village.bootVillager(), null)
  assert.equal(village.overheat('event:3'), null)
  assert.deepEqual(load().snapshot().round, down)
  assert.equal(village.restartRound(1), null, 'must wait for countdown')
  advance(ROUND_RESTART_MS)
  const resumed = load()
  assert.equal(resumed.restartRound(99), null)
  assert.equal(resumed.restartRound(1).number, 2)
  assert.equal(resumed.restartRound(1), null)
  assert.equal(resumed.raw.waterFed, 10)
  assert.deepEqual(resumed.raw.population, ['Cinder', 'Ember'])
  assert.deepEqual(resumed.raw.homeLots, { Cinder: 0, Ember: 1 })
  assert.equal(resumed.raw.roles.Cinder, 'coolant')
  assert.equal(resumed.snapshot().startedAt, new Date(Date.parse(down.restartAt)).toISOString())
  assert.equal(resumed.overheat('event:2'), null)
  assert.equal(resumed.overheat('event:4', { at: down.destroyedAt }), null, 'late old event is ignored')
  assert.equal(resumed.raw.waterFed, 10)
  assert.equal(load().snapshot().round.number, 2)
})

test('refilling an empty Server saves it from the next blast', (t) => {
  const { village } = fixture(t)
  village.overheat('event:1')
  village.feedCoolant('Cinder')
  assert.equal(village.overheat('event:2').destroyed, undefined)
  assert.equal(village.snapshot().round.phase, 'active')
})

test('failed defeat and reboot persistence roll back and remain retryable', (t) => {
  const { village, path, advance } = fixture(t)
  village.overheat('event:1')
  const tmp = `${path}.${process.pid}.tmp`
  mkdirSync(tmp)
  assert.throws(() => village.overheat('event:2'), { code: 'VILLAGE_PERSIST_FAILED' })
  assert.equal(village.snapshot().round.phase, 'active')
  rmSync(tmp, { recursive: true })
  village.overheat('event:2')
  advance(ROUND_RESTART_MS)
  mkdirSync(tmp)
  assert.throws(() => village.restartRound(1), { code: 'VILLAGE_PERSIST_FAILED' })
  assert.equal(village.raw.round.phase, 'restarting')
  assert.equal(village.raw.waterFed, 0)
  assert.equal(JSON.parse(readFileSync(path)).round.phase, 'restarting')
  rmSync(tmp, { recursive: true })
  assert.equal(village.restartRound(1).number, 2)
})

test('repair failures retry with a delay; overlapping ticks cannot reboot twice', async (t) => {
  const { village, advance, now } = fixture(t)
  village.adopt({ waterFed: 0 })
  village.overheat('event:1')
  let calls = 0, completed = 0, release
  const tick = createRoundRestarter({ village, now,
    restore: async () => { if (++calls === 1) throw new Error('RCON down'); await new Promise((r) => { release = r }) },
    onRestart: () => completed++ })
  await tick()
  assert.equal(calls, 0)
  advance(ROUND_RESTART_MS)
  await tick()
  assert.equal(village.raw.round.phase, 'restarting')
  await tick()
  assert.equal(calls, 1)
  advance(5000)
  const pending = tick()
  await tick()
  assert.equal(calls, 2)
  release()
  await pending
  await tick()
  assert.equal(completed, 1)
  assert.equal(village.raw.round.number, 2)
})

test('fixture restoration is verified and refuses to overwrite occupied blocks', async () => {
  const commands = []
  const flag = { x: 1, y: 64, z: 2 }
  await restoreServer({ send: async (command) => {
    commands.push(command)
    return command.startsWith('execute if block') ? 'Test passed' : 'Changed the block'
  } }, flag)
  assert.equal(commands.filter((c) => c.includes('run setblock')).length, 18)
  assert.ok(commands.filter((c) => c.includes('run setblock')).every((c) => /minecraft:(air|water|lava) run/.test(c)))
  assert.ok(commands.every((c) => !/fill |give |kill |teleport /.test(c)))
  await assert.rejects(restoreServer({ send: async () => 'Test failed' }, flag), /not restored/)
  await assert.rejects(restoreServer({ send: async () => 'Test passed' }, { x: NaN, y: 64, z: 2 }), /Invalid/)
})
