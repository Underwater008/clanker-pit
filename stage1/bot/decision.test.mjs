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
    minRequestIntervalMs: 0,
  })

test('one executable action is labeled as policy and never billed to Jev', async () => {
  let calls = 0
  const dm = makeDm(async () => { calls++; return { choice: 'explore' } },
    fakeSkills({ options: { descend_from_perch: 'Step to inspected landing' } }))
  const result = await dm.next()
  assert.equal(result.choice, 'descend_from_perch')
  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'single_option')
  assert.equal(calls, 0)
  dm.close()
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

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('slow provider remains one request while bounded-wait fallback actions continue', async () => {
  const first = deferred()
  let calls = 0
  const events = []
  const dm = createDecisionMaker({
    jevChoose: () => { calls++; return first.promise }, identity,
    getPlan: () => ({}), skills: fakeSkills(), sleep,
    log: (event, data) => events.push({ event, ...data }),
    waitCapMs: 5, minRequestIntervalMs: 0,
  })
  for (let i = 0; i < 4; i++) {
    const result = await dm.next()
    assert.equal(result.source, 'fallback')
    assert.equal(result.reason, 'request_pending')
  }
  assert.equal(calls, 1, 'wait cap must not abandon an active provider request')
  assert.ok(events.some((e) => e.event === 'fallback_decision' && e.requestPending))
  first.resolve({ choice: 'explore' })
  const result = await dm.next()
  assert.equal(result.choice, 'explore')
  assert.equal(result.source, 'jev')
  dm.close()
})

test('cancel aborts the transport and a late reply cannot become a decision', async () => {
  const request = deferred()
  let calls = 0, requestSignal
  const dm = createDecisionMaker({
    jevChoose: ({ signal }) => { calls++; requestSignal = signal; return request.promise },
    identity, getPlan: () => ({}), skills: fakeSkills(), sleep, log: () => {},
    waitCapMs: 5, minRequestIntervalMs: 1000,
  })
  await dm.next()
  dm.cancel('action_failed')
  assert.equal(requestSignal.aborted, true)
  const whileCancelling = await dm.next()
  assert.equal(whileCancelling.source, 'fallback')
  assert.equal(calls, 1)
  request.resolve({ choice: 'explore' })
  await sleep(0)
  const afterCancel = await dm.next()
  assert.equal(afterCancel.source, 'fallback')
  assert.equal(afterCancel.choice, 'gather_wood', 'cancelled reply must be discarded')
  dm.close()
})

test('fast failures do not cause a provider request on every failed action', async () => {
  let calls = 0
  const dm = createDecisionMaker({
    jevChoose: async () => { calls++; return { error: 'HTTP 503' } },
    identity, getPlan: () => ({}), skills: fakeSkills(), sleep, log: () => {},
    waitCapMs: 5, minRequestIntervalMs: 1000,
  })
  const first = await dm.next()
  assert.equal(first.reason, 'provider_error')
  for (let i = 0; i < 20; i++) await dm.next()
  assert.equal(calls, 1)
  dm.close()
})

test('a prefetched choice expires even if its action is still feasible', async () => {
  const dm = createDecisionMaker({
    jevChoose: async () => ({ choice: 'explore' }),
    identity, getPlan: () => ({}), skills: fakeSkills(), sleep, log: () => {},
    minRequestIntervalMs: 0, maxChoiceAgeMs: 5,
  })
  await dm.next()
  await sleep(15)
  const result = await dm.next()
  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'expired_observation')
  dm.close()
})

test('billing errors pause Jev calls while retaining honest fallback and recover after cooldown', async (t) => {
  let now = 1000, calls = 0
  t.mock.method(Date, 'now', () => now)
  const events = []
  const dm = createDecisionMaker({
    jevChoose: async () => {
      calls++
      return calls === 1
        ? { error: 'HTTP 402: billing_error no available credits', status: 402 }
        : { choice: 'explore' }
    },
    identity, getPlan: () => ({}), skills: fakeSkills(), sleep,
    log: (event, data) => events.push({ event, ...data }),
  })
  const first = await dm.next()
  assert.equal(first.source, 'fallback')
  assert.equal(first.reason, 'billing_unavailable')
  dm.cancel('plan_changed')
  dm.cancel('safety_reflex')
  assert.equal(events.filter((e) => e.event === 'jev_status').at(-1).status, 'error')
  for (let i = 0; i < 30; i++) {
    now += 3000
    const next = await dm.next()
    assert.equal(next.reason, 'billing_unavailable')
  }
  assert.equal(calls, 1, 'billing pause must survive many action cycles')
  const latest = events.filter((e) => e.event === 'fallback_decision').at(-1)
  assert.match(latest.error, /no available credits/)
  assert.equal(latest.retryAt, new Date(301000).toISOString())
  now = 301001
  const recovered = await dm.next()
  assert.equal(calls, 2)
  assert.equal(recovered.source, 'jev')
  assert.equal(recovered.choice, 'explore')
  dm.close()
})
