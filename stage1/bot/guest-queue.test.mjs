import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GuestQueue,
  sanitizeNickname,
  TURN_MAX_MS,
  TURN_EVERY_MS,
} from './guest-queue.mjs'

const minute = 60_000
function makeQueue(overrides = {}) {
  let now = 1_000_000
  let seed = 0x2f6e2b1
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const queue = new GuestQueue({
    now: () => now,
    random,
    turnEveryMs: 3 * minute,
    turnMaxMs: 4 * minute,
    maxQueue: 3,
    idleEndMs: 45_000,
    reservedNames: ['Cinder', 'Ember', 'ClankerCam'],
    ...overrides,
  })
  return {
    queue,
    advance: (ms) => {
      now += ms
    },
    get now() {
      return now
    },
  }
}

test('nicknames must be minecraft-safe', () => {
  assert.equal(sanitizeNickname('Piper_9'), 'Piper_9')
  assert.equal(sanitizeNickname('  Xiao '), 'Xiao')
  assert.equal(sanitizeNickname('苦力怕'), null, 'non-ASCII is rejected')
  assert.equal(sanitizeNickname('a'), null, 'too short')
  assert.equal(sanitizeNickname('x'.repeat(30)), 'x'.repeat(14))
  assert.equal(sanitizeNickname('<script>alert(1)</script>'), 'scriptalert1sc')
  assert.equal(sanitizeNickname(null), null)
})

test('an idle stream starts immediately for the first joiner, and slots stay booked after a turn', () => {
  const { queue, advance } = makeQueue()
  advance(10 * minute) // long idle stream, slots skipped
  assert.equal(queue.join('Ada').ok, true)
  // Overdue slot: Ada becomes a creeper on the next tick, no waiting.
  const spawn = queue.tick()
  assert.equal(spawn.spawn.nickname, 'Ada')
  queue.finishActive('boom')
  queue.join('Bo')
  advance(20_000)
  assert.equal(queue.tick().spawn, undefined, 'slot is booked one cadence out')
  advance(3 * minute - 20_000)
  const next = queue.tick()
  assert.equal(next.spawn.nickname, 'Bo')
})

test('turn slots spawn the queue head and keep a 3 minute cadence', () => {
  const { queue, advance } = makeQueue()
  queue.join('Ada')
  queue.join('Bo')
  const spawn = queue.tick() // idle stream: first joiner spawns at once
  assert.equal(spawn.spawn.nickname, 'Ada')
  queue.markSpawned('Ada')
  assert.equal(queue.status().active.nickname, 'Ada')
  // Bo must wait for the next slot even though Ada boomed immediately.
  queue.finishActive('boom') // slot booked for Ada's spawn + 3 minutes
  advance(10_000)
  assert.equal(queue.tick().spawn, undefined)
  advance(3 * minute - 10_000)
  const next = queue.tick()
  assert.equal(next.spawn.nickname, 'Bo')
})

test('rejoining after a boom cannot shortcut the cadence', () => {
  const { queue, advance } = makeQueue()
  queue.join('Ada')
  queue.tick() // Ada spawns immediately
  advance(30_000)
  queue.finishActive('boom')
  const again = queue.join('Ada')
  assert.equal(again.ok, true)
  advance(20_000)
  assert.equal(queue.tick().spawn, undefined, 'slot is still booked 3 minutes out')
})

test('a turn ends on timeout and an idle guest frees the slot', () => {
  const { queue, advance } = makeQueue()
  queue.join('Ada')
  advance(20_000)
  const { spawn } = queue.tick()
  queue.markSpawned('Ada')
  // No input ever arrives: idle end fires before the hard cap.
  advance(46_000)
  const idle = queue.tick()
  assert.equal(idle.end.reason, 'idle')
  assert.equal(idle.end.entry.nickname, 'Ada')
  // With input trickling in, the hard cap ends the turn.
  queue.join('Bo')
  advance(3 * minute)
  const second = queue.tick()
  assert.equal(second.spawn.nickname, 'Bo')
  queue.markSpawned('Bo')
  queue.active.lastInputAt = queue.active.startedAt // input present
  queue.tick()
  advance(4 * minute)
  const ended = queue.tick()
  assert.equal(ended.end.reason, 'timeout')
  assert.equal(second.spawn.nickname, 'Bo')
  assert.ok(spawn.token)
})

test('queue capacity and duplicate names are enforced', () => {
  const { queue } = makeQueue()
  assert.equal(queue.join('Ada').ok, true)
  assert.equal(queue.join('Bo').ok, true)
  assert.equal(queue.join('Cy').ok, true)
  assert.match(queue.join('Dee').error, /full/)
  assert.match(queue.join('Ada').error, /already queued/)
  assert.equal(queue.leave('not-a-token'), false)
})

test('reserved names are rejected — they would kick real players', () => {
  const { queue } = makeQueue()
  assert.match(queue.join('Cinder').error, /belongs to the village/)
  assert.match(queue.join('cinder').error, /belongs to the village/, 'case-insensitive')
  assert.match(queue.join('EMBER').error, /belongs to the village/)
  assert.match(queue.join('ClankerCam').error, /belongs to the village/)
  assert.match(queue.join('ViewBob').error, /reserved for the arena crew/)
  assert.match(queue.join('CamQ').error, /reserved for the arena crew/)
  assert.match(queue.join('FlagSetup').error, /reserved for the arena crew/)
  assert.equal(queue.join('CinderFan').ok, true, 'similar-but-distinct names pass')
})

test('the active guest cannot be impersonated by a queued duplicate', () => {
  const { queue, advance } = makeQueue()
  queue.join('Ada')
  const spawn = queue.tick()
  assert.equal(spawn.spawn.nickname, 'Ada')
  assert.match(queue.join('Ada').error, /playing right now/)
})

test('tokens come from the injected source, not Math.random alone', () => {
  const { queue } = makeQueue({
    makeToken: () => 'crypto-token-1',
  })
  const joined = queue.join('Ada')
  assert.equal(joined.token, 'crypto-token-1')
})

test('the default turn cap matches the cadence so full turns never stretch it', () => {
  assert.equal(TURN_MAX_MS, TURN_EVERY_MS)
})

test('status is safe for the public snapshot (no tokens)', () => {
  const { queue, advance } = makeQueue()
  const joined = queue.join('Ada')
  advance(20_000)
  queue.tick()
  const status = JSON.parse(JSON.stringify(queue.status()))
  assert.equal(status.queueLength, 0)
  assert.equal(status.active.nickname, 'Ada')
  assert.ok(!JSON.stringify(status).includes(joined.token))
  assert.equal(status.nextTurnInMs >= 0, true)
  assert.equal(status.turnEveryMs, 3 * minute)
})

test('controls are only accepted for the active guest token', () => {
  const { queue, advance } = makeQueue()
  const ada = queue.join('Ada')
  assert.equal(queue.controlsFor(ada.token), null, 'no active turn yet')
  advance(20_000)
  queue.tick()
  assert.ok(queue.controlsFor(ada.token), 'Ada is active')
  const bo = queue.join('Bo')
  assert.equal(queue.controlsFor(bo.token), null, 'Bo is still queued')
})

test('the default cadence matches the product rule: one creeper every 3 minutes', () => {
  assert.equal(
    Number(process.env.GUEST_TURN_EVERY_MS ?? 180000),
    3 * minute,
  )
})
