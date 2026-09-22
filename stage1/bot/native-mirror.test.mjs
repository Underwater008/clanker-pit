import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import mc from 'minecraft-protocol'
import {
  MirrorCache,
  createNativeMirror,
  wrapAngle,
  chaseAngle,
  interpolatePositionAt,
} from './native-mirror.mjs'

test('wrapAngle takes the shortest rotation path across the wrap point', () => {
  assert.ok(Math.abs(wrapAngle(0.5) - 0.5) < 1e-12)
  assert.ok(Math.abs(wrapAngle(-0.5) + 0.5) < 1e-12)
  // 1.75pi and -0.25pi are the same orientation
  assert.ok(Math.abs(wrapAngle(1.75 * Math.PI) + 0.25 * Math.PI) < 1e-12)
  assert.ok(Math.abs(wrapAngle(-1.75 * Math.PI) - 0.25 * Math.PI) < 1e-12)
})

test('chaseAngle steps toward the target within the turn budget', () => {
  // Small corrections land exactly on the target.
  assert.ok(Math.abs(chaseAngle(0, 0.05, 0.1) - 0.05) < 1e-12)
  // A large turn is clipped to the per-step budget.
  assert.ok(Math.abs(chaseAngle(0, Math.PI, 0.1) - 0.1) < 1e-12)
  assert.ok(Math.abs(chaseAngle(0, -Math.PI, 0.2) + 0.2) < 1e-12)
  // Crossing the wrap point takes the short way: 3 -> -3 is a 0.28 step forward.
  assert.ok(Math.abs(chaseAngle(3, -3, 0.2) - 3.2) < 1e-12)
})

test('interpolatePositionAt lerps between bracketing samples', () => {
  const samples = [
    { t: 0, x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
    { t: 50, x: 2, y: 64, z: 0, yaw: 1, pitch: 0 },
    { t: 100, x: 4, y: 65, z: 2, yaw: 2, pitch: 1 },
  ]
  const mid = interpolatePositionAt(samples, 75)
  assert.equal(mid.x, 3)
  assert.equal(mid.y, 64.5)
  assert.equal(mid.z, 1)
  // Before the first sample: clamp to it. After the last: freeze on it.
  assert.deepEqual(interpolatePositionAt(samples, -10), samples[0])
  const late = interpolatePositionAt(samples, 500)
  assert.equal(late.x, 4)
  assert.equal(late.y, 65)
  assert.equal(late.z, 2)
  assert.equal(interpolatePositionAt([], 0), null)
})

test('a 20 Hz walk sampled to 60 Hz produces monotone small steps', () => {
  // Simulate the old complaint: walking at 4.3 blocks/s sampled every 50 ms.
  const samples = []
  for (let i = 0; i < 10; i++)
    samples.push({ t: i * 50, x: i * 0.215, y: 64, z: 0, yaw: 0, pitch: 0 })
  let prev = null,
    maxStep = 0
  for (let t = 80; t < 500; t += 17) {
    const p = interpolatePositionAt(samples, t)
    if (prev !== null) maxStep = Math.max(maxStep, Math.abs(p.x - prev))
    prev = p.x
  }
  // Camera steps must be far below the old 50 ms teleport jumps (0.215).
  assert.ok(maxStep < 0.08, `max camera step ${maxStep}`)
})

test('MirrorCache still stores singleton packets', () => {
  const cache = new MirrorCache()
  cache.accept('login', { entityId: 1 })
  assert.deepEqual(cache.base.get('login'), { entityId: 1 })
  cache.accept('respawn', { dimension: 'overworld' })
  assert.equal(cache.chunks.size, 0)
})

test('late native viewers receive the chunk-loading event after world setup and before chunks', (t) => {
  const server = new EventEmitter()
  server.close = () => {}
  t.mock.method(mc, 'createServer', () => server)
  const mirror = createNativeMirror({ port: 0, name: 'Test' })
  t.after(() => mirror.close())

  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  bot.entity = { id: 1, position: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0 }
  bot.entities = {}
  mirror.attach(bot)
  const receive = (name, data) => bot._client.emit('packet', data, { name, state: 'play' })
  receive('login', { entityId: 1 })
  // The real server sends this before any native viewer is connected.
  receive('game_state_change', { reason: 13, gameMode: 0 })
  receive('map_chunk', { x: 0, z: 0 })
  bot.emit('spawn')

  function joinViewer() {
    const viewer = new EventEmitter()
    const packets = []
    viewer.state = 'play'
    viewer.serializer = { createPacketBuffer: (packet) => packet }
    viewer.writeRaw = (packet) => packets.push(packet)
    viewer.end = () => { viewer.state = 'disconnected'; viewer.emit('end') }
    server.emit('playerJoin', viewer)
    return packets
  }
  function assertLoadingOrder(packets, afterRespawn = false) {
    const names = packets.map((p) => p.name)
    const events = packets.filter((p) => p.name === 'game_state_change')
    assert.deepEqual(events, [{ name: 'game_state_change', params: { reason: 13, gameMode: 0 } }])
    const start = names.indexOf('game_state_change')
    assert.ok(start > names.indexOf('login'))
    if (afterRespawn) assert.ok(start > names.indexOf('respawn'))
    assert.ok(start < names.indexOf('map_chunk'))
    assert.equal(packets.find((p) => p.name === 'position').params.y, 64)
  }
  assertLoadingOrder(joinViewer())
  // The event must be repeated for a replacement display and must follow a
  // cached respawn; replaying it earlier would reset the client's load state.
  receive('respawn', { dimension: 'overworld' })
  receive('map_chunk', { x: 0, z: 0 })
  assertLoadingOrder(joinViewer(), true)
})
