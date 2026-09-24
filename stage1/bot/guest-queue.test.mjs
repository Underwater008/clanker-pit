import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GuestQueue,
  sanitizeNickname,
  TURN_MAX_MS,
  TURN_EVERY_MS,
  restoreGuestHistory,
} from './guest-queue.mjs'

const minute = 60_000

test('Server reboot ends an active turn and preserves queued guests until resumed', () => {
  const { queue, advance } = makeQueue()
  queue.join('Xiao')
  queue.join('Ada')
  assert.equal(queue.tick().spawn.nickname, 'Xiao')
  assert.equal(queue.tick({ paused: true }).end.reason, 'server-destroyed')
  advance(4 * minute)
  assert.deepEqual(queue.tick({ paused: true }), {})
  assert.deepEqual(queue.status().queuePreview, ['Ada'])
  assert.equal(queue.tick().spawn.nickname, 'Ada')
})

test('filler names are scheduled entries without public source labels or tokens', () => {
  const { queue, advance } = makeQueue({ fillersEnabled: true, maxQueue: 20 })
  const first = queue.tick().spawn
  assert.equal(first.kind, 'clanker')
  assert.ok(first.nickname)
  for (let i = 0; i < 8; i++) { advance(4000); queue.tick() }
  const publicState = queue.status()
  assert.ok(publicState.queueLength >= 1 && publicState.queueLength <= 5)
  assert.equal(publicState.active.nickname, first.nickname)
  assert.ok(publicState.queueEntries.every((e) => !('kind' in e) && !('token' in e)))
  assert.ok(!('kind' in publicState.active) && !('token' in publicState.active))
  assert.ok(!('humanQueueLength' in publicState))
  assert.ok(!('fillersEnabled' in publicState))
  assert.equal(queue.controlsFor(first.token), null, 'a filler can never take browser input')
})

test('humans move ahead of waiting clankers without emptying the queue and the active clanker yields within eight seconds', () => {
  const { queue, advance } = makeQueue({ fillersEnabled: true, maxQueue: 20 })
  queue.tick()
  advance(10000)
  queue.tick()
  const waitingNames = queue.status().queuePreview
  assert.ok(waitingNames.length > 0)
  assert.equal(queue.join('Xiao').position, 1)
  assert.equal(queue.join('Ada').position, 2)
  assert.deepEqual(queue.status().queuePreview, ['Xiao', 'Ada', ...waitingNames])
  advance(7999)
  assert.equal(queue.tick().end, undefined)
  advance(1)
  assert.equal(queue.tick().end.reason, 'yield')
  assert.equal(queue.tick().spawn.nickname, 'Xiao')
  assert.deepEqual(queue.status().queuePreview.slice(0, 1 + waitingNames.length), ['Ada', ...waitingNames])
  assert.equal(queue.active.kind, 'human')
})

test('a crowded human queue stays FIFO and receives no filler names', () => {
  const { queue, advance } = makeQueue({ fillersEnabled: true, maxQueue: 20 })
  for (let i = 0; i < 9; i++) assert.equal(queue.join(`Human_${i}`).position, i + 1)
  for (let i = 0; i < 3; i++) {
    assert.equal(queue.tick().spawn.nickname, `Human_${i}`)
    advance(10000)
    assert.ok(queue.queue.every((e) => e.kind === 'human'))
    queue.finishActive('boom')
    advance(3 * minute)
  }
  assert.equal(queue.status().queueEntries.length, 5)
  assert.equal(queue.status().queueLength, 6)
})

test('unavailable native runner removes fillers and does not advertise pretend entries', () => {
  const { queue } = makeQueue({ fillersEnabled: true })
  queue.refill()
  assert.equal(queue.queue.length, 1)
  queue.setFillersEnabled(false)
  assert.equal(queue.status().queueLength, 0)
  queue.tick()
  assert.equal(queue.active, null)
})

test('gateway restart retains confirmed unconsumed booms and the shared chat cursor', () => {
  const boom = { id: 40, type: 'boom', position: { x: 0, y: 64, z: 0 } }
  const chat = { id: 41, text: 'hello' }
  const restored = restoreGuestHistory({ seq: 39, events: [boom], chat: [chat] })
  assert.deepEqual(restored, { seq: 41, events: [boom], chat: [chat] })
  assert.deepEqual(restoreGuestHistory(null), { seq: 0, events: [], chat: [] })
})

test('late spawn and teardown from a prior guest cannot affect the next turn', () => {
  let now = 1000
  let seq = 0
  const queue = new GuestQueue({ now: () => now, makeToken: () => `token-${++seq}`, turnEveryMs: 100 })
  queue.join('Ada')
  const old = queue.tick().spawn
  queue.finishActive('boom', old.token)
  queue.join('Bo')
  now += 100
  const current = queue.tick().spawn
  queue.markSpawned('Ada', old.token)
  assert.equal(queue.active.spawned, false)
  assert.equal(queue.finishActive('disconnected', old.token), null)
  assert.equal(queue.active.token, current.token)
  queue.markSpawned('Bo', current.token)
  assert.equal(queue.active.botName, 'Bo')
})
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
  // Camera startup does not count as idling, even if it takes a while.
  advance(46_000)
  assert.equal(queue.tick().end, undefined)
  queue.markCameraReady('wrong-token')
  assert.equal(queue.active.cameraReadyAt, undefined)
  queue.markCameraReady(spawn.token)
  assert.equal(queue.active.cameraReadyAt, queue.active.lastInputAt)
  assert.equal(queue.tick().end, undefined)
  // Once the camera connects, no input frees the slot before the hard cap.
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

test('camera startup does not consume the playable turn', () => {
  const { queue, advance } = makeQueue({ turnMaxMs: 3 * minute })
  queue.join('Ada')
  const { spawn } = queue.tick()
  const originalEnd = queue.active.endsAt
  advance(30_000)
  queue.markCameraReady(spawn.token)
  assert.equal(queue.active.endsAt, originalEnd + 30_000)
  assert.equal(queue.status().active.remainingMs, 3 * minute)
  queue.markCameraReady(spawn.token)
  assert.equal(queue.active.endsAt, originalEnd + 30_000, 'repeated status reads cannot extend a turn')
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


test('a human can take a waiting clanker name without duplicate names or losing other entries', () => {
  const { queue } = makeQueue({ fillersEnabled: true })
  queue.refill()
  const nickname = queue.queue[0].nickname
  const human = queue.join(nickname)
  assert.equal(human.position, 1)
  assert.equal(queue.queue.filter((e) => e.nickname === nickname).length, 1)
  assert.equal(queue.tick().spawn.token, human.token)
})

test('quiet queues replenish behind humans without using human capacity or delaying them', () => {
  const { queue, advance } = makeQueue({ fillersEnabled: true, maxQueue: 3 })
  const human = queue.join('Xiao')
  queue.fillerTarget = 3
  queue.refill()
  advance(10000)
  queue.refill()
  assert.equal(queue.queue.length, 3)
  assert.equal(queue.position(human.token).position, 1)
  assert.equal(queue.join('Ada').position, 2)
  assert.equal(queue.join('Bo').position, 3)
  assert.match(queue.join('Cy').error, /full/)
  assert.equal(queue.tick().spawn.token, human.token)
})
