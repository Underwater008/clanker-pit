import test from 'node:test'
import assert from 'node:assert/strict'
import { guestCameraStatus } from './guest-camera.mjs'

const now = 100000
const current = { ready: true, viewer: true, generation: now - 1000, updated: now - 100 }
const status = (mirror = current, extra = {}) => guestCameraStatus({
  active: true, attachedAt: now - 1000, mirror, now, ...extra,
})

test('guest camera is ready only with a fresh viewer for this turn', () => {
  assert.deepEqual(status(), { status: 'connected', ready: true })
  assert.deepEqual(status({ ...current, viewer: false }), { status: 'starting', ready: false })
  assert.equal(status({ ...current, ready: false }).ready, false)
  assert.equal(status({ ...current, generation: now - 2000 }).ready, false)
})

test('missing, stale and invalid mirror status never announce a ready camera', () => {
  for (const mirror of [null, {}, { ...current, updated: now - 8000 },
    { ...current, updated: now + 5000 }, { ...current, generation: '100000' }]) {
    assert.deepEqual(status(mirror), { status: 'starting', ready: false })
  }
  assert.equal(status(current, { attachedAt: null }).ready, false)
})

test('idle status exposes no mirror internals or stale connected state', () => {
  assert.deepEqual(status({ ...current, port: 25584, token: 'private' }, { active: false }),
    { status: 'idle', ready: false })
  assert.deepEqual(Object.keys(status()).sort(), ['ready', 'status'])
})
