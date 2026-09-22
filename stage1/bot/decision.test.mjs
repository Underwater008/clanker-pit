import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDecisionMaker } from './decision.mjs'

const identity = {
  name: 'Test',
  dispositions: ['bold'],
  current_goal: 'test goal',
}
const fakeSkills = ({
  options = { gather_wood: 'chop', explore: 'scout' },
  emergency = () => null,
} = {}) => ({
  observation: () => ({ food: 20 }),
  candidates: () => ({ ...options }),
  emergency,
})
const makeDm = (jevChoose, skills) =>
  createDecisionMaker({
    jevChoose,
    identity,
    getPlan: () => ({ goal: 'build_shelter' }),
    skills: skills ?? fakeSkills(),
    log: () => {},
    sleep,
  })

test('choices come from jev and consecutive decisions overlap instead of idling', async () => {
  let calls = 0
  const dm = makeDm(async () => {
    calls++
    await sleep(300)
    return { choice: 'gather_wood', confidence: 0.9, model: 'jev-test' }
  })
  const t0 = Date.now()
  const first = await dm.next()
  assert.equal(first.choice, 'gather_wood')
  assert.equal(first.source, 'jev')
  // Simulate a 1 s action: the next decision was fired before the action ran.
  await sleep(1000)
  const second = await dm.next()
  assert.equal(second.choice, 'gather_wood')
  assert.equal(second.source, 'jev')
  // Initial request plus one prefetch per choice: overlap, not an idle gate.
  assert.equal(calls, 3)
  // Two model decisions in ~1.3 s of wall time: no fixed interval gate.
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`)
})

test('emergency during the wait preempts with a safety reflex', async () => {
  let danger = false
  const dm = makeDm(
    async () => {
      await sleep(1500)
      return { choice: 'gather_wood' }
    },
    fakeSkills({ emergency: () => (danger ? 'flee' : null) }),
  )
  setTimeout(() => {
    danger = true
  }, 300)
  const r = await dm.next()
  assert.equal(r.urgent, 'flee')
})

test('a choice that is no longer feasible falls back to policy', async () => {
  const dm = makeDm(async () => ({ choice: 'mine_stone' })) // not in candidates
  const r = await dm.next()
  assert.equal(r.choice, 'gather_wood')
  assert.equal(r.source, 'fallback')
})

test('provider errors fall back to policy instead of throwing', async () => {
  const dm = makeDm(async () => {
    await sleep(50)
    throw new Error('HTTP 503')
  })
  const r = await dm.next()
  assert.equal(r.choice, 'gather_wood')
  assert.equal(r.source, 'fallback')
})
