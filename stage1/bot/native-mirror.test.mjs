import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MirrorCache,
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
