// Model-authored programs, not a menu of scenario-specific jobs.
export const ACTION_CONTRACT = {
  inspect: 'No arguments. Return fresh local blocks/inventory. Does not move.',
  move: 'target:[x,y,z] integer feet cell. Walk only; no automatic digging/placing. Must have safe support/headroom.',
  step: 'dx,dz numbers; horizontal displacement at most 0.8 blocks, while sneaking. Fine positioning on edges; no jumping or flight.',
  dig: 'target:[x,y,z], expect:block_name. Remove exactly one reachable editable block; no walking or automatic tool selection.',
  place: 'target:[x,y,z], item:item_name. Place one carried solid block against a reachable face; no walking, towers or replacement.',
  craft: 'item:item_name, times:1..4, optional table:[x,y,z]. Craft only with present ingredients and reachable table; no gathering/walking.',
  equip: 'item:item_name. Equip a carried item in hand.',
  interact: 'target:[x,y,z], expect:block_name. Empty-hand toggle a reachable wooden door, gate, lever or button. No inventories or fluid pouring.',
  wait: 'ticks:1..20. Yield briefly for server updates or item pickup. Not progress.',
}
const itemName = (s) => typeof s === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(s)
const coordinate = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isSafeInteger)
const fields = {
  inspect: [], move: ['target'], step: ['dx', 'dz'], dig: ['target', 'expect'], place: ['target', 'item'],
  craft: ['item', 'times', 'table'], equip: ['item'], interact: ['target', 'expect'], wait: ['ticks'],
}
export function validateAction(step) {
  if (!step || typeof step !== 'object' || !Object.hasOwn(fields, step.op)) throw Error(`Unknown primitive: use the op field, received ${JSON.stringify(step).slice(0,180)}`)
  if (Object.keys(step).some((k) => k !== 'op' && !fields[step.op].includes(k))) throw Error('Unexpected primitive field')
  for (const k of ['target', 'table']) if ((k === 'target' && fields[step.op].includes(k) || step[k] != null) && !coordinate(step[k]))
    throw Error('Primitive coordinates must be three finite integers')
  for (const k of ['expect', 'item']) if (fields[step.op].includes(k) && !itemName(step[k])) throw Error(`Invalid ${k}`)
  if (step.op === 'step' && (![step.dx,step.dz].every(Number.isFinite) || Math.hypot(step.dx,step.dz) > .8 || Math.hypot(step.dx,step.dz) < .05)) throw Error('Invalid fine movement')
  if (step.op === 'craft' && (!Number.isInteger(step.times) || step.times < 1 || step.times > 4)) throw Error('Invalid craft count')
  if (step.op === 'wait' && (!Number.isInteger(step.ticks) || step.ticks < 1 || step.ticks > 20)) throw Error('Invalid wait duration')
  return structuredClone(step)
}
export function observedPositions(observation) {
  const known = new Set(observation.blocks.flatMap((b) => b.positions.map((p) => p.join(','))))
  if (observation.bounds) {
    const { min, max } = observation.bounds
    const unknown = new Set((observation.unloaded ?? []).map((p) => p.join(',')))
    for(let x=min[0];x<=max[0];x++) for(let y=min[1];y<=max[1];y++) for(let z=min[2];z<=max[2];z++) {
      const key=[x,y,z].join(','); if(!unknown.has(key)) known.add(key)
    }
  }
  return known
}
export function validatePrograms(value, observation) {
  if (!value || typeof value.intention !== 'string' || !Array.isArray(value.alternatives) ||
      value.alternatives.length < 1 || value.alternatives.length > 3) throw Error('Return 1-3 alternative programs')
  const known = observedPositions(observation)
  const alternatives = value.alternatives.map((p, index) => {
    if (typeof p.reason !== 'string' || !Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > 8)
      throw Error('Each program needs a reason and 1-8 primitive steps')
    const steps = p.steps.map(validateAction)
    for (const s of steps) for (const key of ['target', 'table'])
      if (s[key] && !known.has(s[key].join(','))) throw Error('Target was not in the supplied local observation')
    return { id: `program_${index + 1}`, reason: p.reason.slice(0, 300), steps }
  })
  return { intention: value.intention.slice(0, 400), alternatives }
}
export const primitiveLabel = (s) => `${s.op}${s.target ? ` ${s.target.join(',')}` : s.item ? ` ${s.item}` : ''}`

// Requests never block the gameplay loop. Only server-verified successful
// steps advance a program. Failed steps invalidate the remaining program.
export function createActionPlanner({ planner, jevChoose, identity, objective, primitives, state, log = () => {}, now = Date.now, minIntervalMs = 3000, tactical = false }) {
  const context = () => {
    const {position,dimension,inventory,blocks} = primitives.observe()
    let hash = 2166136261
    for (const c of JSON.stringify({position,dimension,inventory,blocks})) hash = Math.imul(hash ^ c.charCodeAt(0),16777619)
    return hash >>> 0
  }
  const memory = state.primitiveMemory ??= { history: [] }
  memory.history ??= []
  let lastAttemptContext = null
  let queue = [], pending = null, epoch = 0, closed = false, nextRequest = 0, source = 'planner', selected = null
  let status = { status: 'idle' }
  let fast = null, fastReady = null, nextFastAt = 0, attemptSource = null
  const remember = (entry) => { memory.history.push({ at: now(), ...entry }); memory.history = memory.history.slice(-24) }
  function cancel(reason) {
    epoch++; queue = []; selected = null
    pending?.controller.abort()
    fast?.controller.abort(); fastReady = null
    status = { status: closed ? 'closed' : 'interrupted', reason }
  }
  function requestTactical() {
    if(!tactical || !jevChoose || fast || now()<nextFastAt || closed) return
    const steps=primitives.affordances?.() ?? [], fingerprint=context()
    const candidates=steps.filter(step=>!memory.history.some(h=>h.type==='action'&&!h.ok&&h.context===fingerprint&&JSON.stringify(h.step)===JSON.stringify(step)))
    if(candidates.length<2)return
    const job={controller:new AbortController(),revision:epoch,startedAt:now()};fast=job;nextFastAt=now()+1000
    const options=Object.fromEntries(candidates.map((step,i)=>[`action_${i}`,JSON.stringify(step)]))
    job.promise=(async()=>{
      try{
        const result=await jevChoose({identity,stance:{objective:objective(),intention:selected?.intention,verified_history:memory.history.slice(-6)},
          observation:primitives.observe(),options,questionId:'primitive_action',signal:job.controller.signal})
        if(closed||job.revision!==epoch||job.controller.signal.aborted)return
        if(result.error){nextFastAt=now()+(result.status===402?300000:15000);log('primitive_selector_error',{error:result.error});return}
        const index=Object.keys(options).indexOf(result.choice)
        if(index<0)return
        if(fingerprint!==context())return
        fastReady={step:candidates[index],source:'jev_primitives',program:null}
        log('primitive_decision',{step:candidates[index],source:'jev_primitives',durationMs:now()-job.startedAt,model:result.model,confidence:result.confidence})
      }catch(error){nextFastAt=now()+15000;log('primitive_selector_error',{error:String(error)})}
      finally{if(fast===job)fast=null}
    })()
  }
  function request() {
    if (closed || pending || now() < nextRequest) return
    const observation = primitives.observe(), revision = epoch
    const job = { controller: new AbortController(), startedAt: now() }; pending = job
    nextRequest = now() + minIntervalMs
    status = { status: 'pending', requestedAt: new Date(now()).toISOString() }
    log('program_request', { observation: { position: observation.position }, objective: objective() })
    job.promise = (async () => {
      try {
        const response = await planner.program({ identity, objective: objective(), observation,
          history: memory.history.slice(-10), contract: ACTION_CONTRACT, signal: job.controller.signal })
        if (closed || revision !== epoch || job.controller.signal.aborted) return
        if (response.error) {
          nextRequest = now() + (response.status === 402 ? 300000 : 15000)
          throw Error(response.error)
        }
        const program = validatePrograms(response, observation)
        let candidate = program.alternatives[0]
        source = 'planner'
        if (program.alternatives.length > 1 && jevChoose) {
          const options = Object.fromEntries(program.alternatives.map((p) => [p.id, `${p.reason} Steps: ${JSON.stringify(p.steps)}`]))
          const pick = await jevChoose({ identity, stance: { intention: program.intention }, observation,
            options, questionId: 'model_authored_program', signal: job.controller.signal })
          if (closed || revision !== epoch || job.controller.signal.aborted) return
          const match = program.alternatives.find((p) => p.id === pick.choice)
          if (match && !pick.error) { candidate = match; source = 'planner+jev' }
          else { source = 'planner_first_alternative'; log('program_selector_error', { error: pick.error ?? 'Invalid Jev program choice' }) }
        }
        const current = primitives.observe()
        if ((!tactical && Math.hypot(...current.position.map((n, i) => n - observation.position[i])) > .75) || current.dimension !== observation.dimension)
          throw Error('Position changed while planning; discard stale program')
        const previous = memory.history.findLast((h) => h.type === 'action' && !h.ok)
        if (previous?.context === context() && JSON.stringify(previous.step) === JSON.stringify(candidate.steps[0]))
          throw Error('Unchanged failed first step; choose a different action or target')
        selected = { ...candidate, intention: program.intention, source, issuedAt: now(), model: response.model }
        queue = candidate.steps.slice()
        fast?.controller.abort(); fastReady = null
        status = { status: 'ready', durationMs: now() - job.startedAt }
        log('program_ready', { ...selected, alternatives: program.alternatives, durationMs: status.durationMs })
      } catch (error) {
        if (revision === epoch && !closed) {
          status = { status: 'error', error: String(error) }
          remember({ type: 'planning_error', error: String(error) })
          nextRequest = Math.max(nextRequest, now() + minIntervalMs)
          log('program_error', status)
        }
      } finally { if (pending === job) pending = null }
    })()
  }
  return {
    next() {
      if (closed) return null
      if (selected && now() - selected.issuedAt > 120000) { queue = []; selected = null }
      if (!queue.length) {
        request()
        if(fastReady){const choice=fastReady;fastReady=null;lastAttemptContext=context();attemptSource=choice.source;return choice}
        requestTactical();return null
      }
      attemptSource = source
      lastAttemptContext = context()
      return { step: queue.shift(), source, program: selected }
    },
    record(step, { result, error } = {}) {
      remember({ type: 'action', step, source: attemptSource, context: lastAttemptContext, ok: !error, result: result?.observed ? { observed: {position: result.observed.position, inventory: result.observed.inventory} } : result, error: error ? String(error) : undefined })
      if (error) { queue = []; selected = null; nextRequest = now(); log('program_invalidated', { step, error: String(error) }) }
    },
    cancel,
    close() { closed = true; cancel('closed') },
    get status() { return status },
    get pending() { return pending?.promise ?? null },
  }
}
