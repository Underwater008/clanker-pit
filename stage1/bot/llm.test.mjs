import test from 'node:test'
import assert from 'node:assert/strict'
import { makePlanner, jevChoose, post } from './llm.mjs'

const identity = { name: 'Cinder', dispositions: ['careful'], current_goal: 'Build a shelter' }
const planner = () => makePlanner({ name: 'test', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model' })
const input = () => ({
  identity, observation: { shelter: { can_build_here: false } },
  memoryContext: [], goals: { build_shelter: 'Build a local shelter' },
  actions: { gather_wood: 'Gather locally reachable logs' },
  capabilities: { shelter: { materials: ['planks', 'cobblestone'] }, navigation: { pillar_climbing: false } },
})

test('planner preserves an executable nextAction and rejects invented actions', async (t) => {
  let action = 'gather_wood'
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      goal: 'build_shelter', intention: 'Get wood', steps: [], nextAction: action,
    }) } }] }) }))
  assert.equal((await planner().plan(input())).nextAction, 'gather_wood')
  action = 'teleport'
  assert.match((await planner().plan(input())).error, /not an offered/)
})

test('planner receives executable actions and capabilities rather than inventing a skill set', async (t) => {
  let sent
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ goal: 'build_shelter', intention: 'Gather wood for a local shelter', steps: ['gather_wood'] }),
    } }] }) }
  })
  const params = input()
  const result = await planner().plan(params)
  assert.equal(result.goal, 'build_shelter')
  const context = JSON.parse(sent.messages[1].content)
  assert.deepEqual(context.actions, params.actions)
  assert.deepEqual(context.capabilities, params.capabilities)
  assert.match(sent.messages[0].content, /hard executor limits/)
})

test('aborted planner fetch is not retried and reports a bounded cancellation', async (t) => {
  let calls = 0, ready
  const started = new Promise((r) => { ready = r })
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    calls++
    ready()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  const controller = new AbortController()
  const result = planner().plan({ ...input(), signal: controller.signal })
  await started
  controller.abort()
  assert.match((await result).error, /cancelled/)
  assert.equal(calls, 1)
})

test('an already-aborted planner request never reaches the provider', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not fetch') })
  const controller = new AbortController()
  controller.abort()
  const result = await planner().plan({ ...input(), signal: controller.signal })
  assert.match(result.error, /cancelled/)
  assert.equal(calls, 0)
})

test('a transport that ignores abort still releases its request slot at the deadline', async (t) => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const started = Date.now()
  const result = await post('https://example.invalid/v1/chat/completions', 'test-key', {}, 30)
  assert.match(result.error, /deadline exceeded/)
  assert.ok(Date.now() - started < 500)
})

test('a response body that hangs after headers is also bounded', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200, text: () => new Promise(() => {}),
  }))
  const result = await post('https://example.invalid/v1/chat/completions', 'test-key', {}, 30)
  assert.match(result.error, /deadline exceeded/)
})

test('Jev missing credentials fail locally and explicitly', async (t) => {
  const previous = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
  })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not fetch') })
  const result = await jevChoose({ identity, stance: {}, observation: {}, questionId: 'action', options: { explore: 'Explore' } })
  assert.match(result.error, /Jev has no API key/)
  assert.equal(calls, 0)
})

test('council leaves room for reasoning and reports token exhaustion explicitly', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const sent = JSON.parse(options.body)
    calls++
    const truncated = calls === 2 || sent.max_tokens < 1800
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{
      finish_reason: truncated ? 'length' : 'stop',
      message: { content: truncated ? '' : '{"role":"builder","says":"I will raise the wall."}', reasoning_content: 'Choose a useful role.' },
    }] }) }
  })
  const args = { identity: { ...identity, origin: 'Village' }, villageSummary: {}, currentRoles: {}, othersSoFar: [], situation: {} }
  assert.equal((await planner().discuss(args)).role, 'builder')
  const failed = await planner().discuss(args)
  assert.match(failed.error, /1800-token limit/)
  assert.equal(failed.role, undefined)
  assert.equal(calls, 2, 'A truncated reply must not silently trigger another paid call')
})

test('Jev preserves HTTP billing status and never retries a 402 response', async (t) => {
  const previous = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = 'test-key'
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
  })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return { ok: false, status: 402, text: async () => '{"error":"billing_error: no available credits"}' }
  })
  const result = await jevChoose({ identity, stance: {}, observation: {}, questionId: 'action', options: { explore: 'Explore' } })
  assert.equal(result.status, 402)
  assert.match(result.error, /no available credits/)
  assert.equal(calls, 1)
})

test('primitive planner receives mechanics and observations without a scripted job menu', async (t) => {
  let request
  const observation={position:[0,64,0],blocks:[{name:'stone',positions:[[1,64,0]]}]}
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    request=JSON.parse(options.body)
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify({intention:'Clear a block',alternatives:[{reason:'Observed obstacle',steps:[{op:'dig',target:[1,64,0],expect:'stone'}]}]})}}]})}
  })
  const result=await planner().program({identity,objective:'Go east',observation,history:[],contract:{dig:'one block'}})
  assert.equal(result.alternatives[0].steps[0].op,'dig')
  const sent=JSON.parse(request.messages[1].content)
  assert.equal(sent.actions,undefined);assert.deepEqual(sent.observation,observation)
})


test('Kimi K3 uses low reasoning for short primitive programs only',async(t)=>{
 const requests=[]
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  requests.push(JSON.parse(options.body))
  return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify({intention:'Inspect',alternatives:[{reason:'Check local state',steps:[{op:'inspect'}]}]})}}]})}
 })
 const kimi=makePlanner({name:'kimi',baseUrl:'https://example.invalid/v1',apiKey:'test-key',model:'kimi-k3'})
 await kimi.program({identity,objective:'Observe',observation:{position:[0,64,0],blocks:[]},history:[],contract:{inspect:'observe'}})
 assert.equal(requests[0].reasoning_effort,'low')
 assert.equal(requests[0].model,'kimi-k3')
 const other=planner()
 await other.program({identity,objective:'Observe',observation:{position:[0,64,0],blocks:[]},history:[],contract:{inspect:'observe'}})
 assert.equal(requests[1].reasoning_effort,undefined)
})
