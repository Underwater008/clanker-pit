import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { confirmGuestExplosion } from './guest-boom.mjs'

test('a lost summon acknowledgement never retries and can still verify the explosion', async () => {
  const client = new EventEmitter()
  let calls = 0
  const position = { x: 10, y: 64, z: -5 }
  const result = await confirmGuestExplosion({ client, position, timeoutMs: 100,
    summon: async () => {
      calls++
      setTimeout(() => client.emit('explosion', position), 5)
      throw new Error('acknowledgement lost')
    } })
  assert.deepEqual(result, position)
  assert.equal(calls, 1)
  assert.equal(client.listenerCount('explosion'), 0)
})

test('an unrelated explosion or successful summon alone does not count as a boom', async () => {
  const client = new EventEmitter()
  let calls = 0
  const result = await confirmGuestExplosion({ client, position: { x: 0, y: 64, z: 0 }, timeoutMs: 20,
    summon: async () => { calls++; client.emit('explosion', { x: 100, y: 64, z: 0 }); return 'Summoned new Creeper' } })
  assert.equal(result, null)
  assert.equal(calls, 1)
  assert.equal(client.listenerCount('explosion'), 0)
})

test('a stalled summon cannot hold the guest request past the verification deadline', async () => {
  const client = new EventEmitter()
  const result = await confirmGuestExplosion({ client, position: { x: 0, y: 64, z: 0 },
    timeoutMs: 20, summon: () => new Promise(() => {}) })
  assert.equal(result, null)
  assert.equal(client.listenerCount('explosion'), 0)
})
