import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionPlanner, validatePrograms, validateAction, compactPrimitiveHistory, compactPrimitiveObjective } from './action-plan.mjs'
const observation=()=>({position:[0.5,64,0.5],dimension:'overworld',inventory:[],blocks:[{name:'air',positions:[[0,64,0],[1,64,0],[2,64,0]]}]})
const program=(steps)=>({intention:'Reach a useful place',alternatives:[{reason:'Local route',steps}]})
const move=(x)=>({op:'move',target:[x,64,0]})
const setup=(reply,extra={})=>createActionPlanner({planner:{program:reply},identity:{name:'Lab'},objective:()=>({goal:'move'}),primitives:{observe:observation},state:{},minIntervalMs:0,...extra})
test('programs allow authored sequences but reject code, unobserved targets and unbounded work',()=>{
 assert.equal(validatePrograms(program([move(1),move(2)]),observation()).alternatives[0].steps.length,2)
 assert.throws(()=>validatePrograms(program([move(20)]),observation()),/not in.*observation/)
 assert.throws(()=>validateAction({op:'eval',code:'process.exit()'}),/Unknown/)
 assert.throws(()=>validateAction({op:'move',target:[NaN,64,0]}),/finite/)
 assert.throws(()=>validateAction({op:'craft',item:'stick',times:100}),/count/)
 assert.throws(()=>validateAction({op:'dig',target:[1,64,0],expect:'stone',code:'anything'}),/Unexpected/)
 assert.throws(()=>validatePrograms(program(Array(9).fill(move(1))),observation()),/1-8/)
})
test('planning is nonblocking with one request; failure discards the remaining program',async()=>{
 let release,calls=0,history
 const c=setup(async input=>{calls++;history=input.history;return await new Promise(r=>{release=r})})
 assert.equal(c.next(),null);assert.equal(c.next(),null);assert.equal(calls,1)
 release(program([move(1),move(2)]));await c.pending
 const first=c.next();assert.deepEqual(first.step,move(1));assert.equal(first.source,'planner')
 c.record(first.step,{error:Error('No path')})
 assert.equal(c.next(),null);assert.equal(calls,2);assert.equal(history.at(-1).ok,false)
 release(program([move(2)]));await c.pending
 assert.deepEqual(c.next().step,move(2));c.close()
})
test('an unchanged failed action cannot be replayed',async()=>{
 const c=setup(async()=>program([move(1)]))
 c.next();await c.pending;const first=c.next();c.record(first.step,{error:Error('No path')});c.next();await c.pending
 assert.match(c.status.error,/Unchanged failed/);c.close()
})
test('safety cancellation prevents a late model reply from restoring a stale plan',async()=>{
 let release;const c=setup(()=>new Promise(r=>{release=r}))
 c.next();c.cancel('safety_reflex');release(program([move(1)]));await c.pending
 assert.equal(c.status.status,'interrupted');c.close();assert.equal(c.next(),null)
})
test('Jev chooses model-authored programs, and selector errors are labeled',async()=>{
 const response={intention:'Choose a route',alternatives:[{reason:'east',steps:[move(1)]},{reason:'farther east',steps:[move(2)]}]}
 let sent;const c=setup(async()=>response,{jevChoose:async input=>{sent=input;return {choice:'program_2'}}})
 c.next();await c.pending;assert.deepEqual(c.next().step,move(2));assert.match(sent.options.program_2,/"op":"move"/);c.close()
 const events=[];const f=setup(async()=>response,{jevChoose:async()=>({error:'provider offline'}),log:(e,d)=>events.push([e,d])})
 f.next();await f.pending;assert.equal(f.next().source,'planner_first_alternative');assert.ok(events.some(([e])=>e==='program_selector_error'));f.close()
})
test('reload retains evidence but never resumes the old program',async()=>{
 const state={primitiveMemory:{history:[{type:'action',step:move(1),ok:true,result:{moved:1}}]}}
 let input;const c=setup(async i=>{input=i;return program([move(2)])},{state})
 assert.equal(c.next(),null);await c.pending;assert.equal(input.history.length,1);c.close()
})

test('Jev can take a primitive step while Kimi is pending; model programs later take priority',async()=>{
 let release,calls=0
 const c=setup(()=>new Promise(r=>{release=r}),{tactical:true,
  primitives:{observe:observation,affordances:()=>[move(1),move(2)]},
  jevChoose:async()=>{calls++;return {choice:'action_0',model:'jev'}}})
 assert.equal(c.next(),null)
 await new Promise(setImmediate)
 assert.equal(calls,1)
 const fast=c.next();assert.equal(fast.source,'jev_primitives');assert.deepEqual(fast.step,move(1))
 c.record(fast.step,{result:{moved:1}})
 release(program([move(2)]));await c.pending
 const planned=c.next();assert.equal(planned.source,'planner');assert.deepEqual(planned.step,move(2));c.close()
})
test('tactical provider errors never become silently scripted work',async()=>{
 const events=[];let release
 const c=setup(()=>new Promise(r=>{release=r}),{tactical:true,
  primitives:{observe:observation,affordances:()=>[move(1),move(2)]},
  jevChoose:async()=>({error:'HTTP 402',status:402}),log:(e,d)=>events.push([e,d])})
 c.next();await new Promise(setImmediate);assert.equal(c.next(),null)
 assert.ok(events.some(([e])=>e==='primitive_selector_error'));c.close();release(program([move(1)]));await c.pending
})


test('native input is bounded and cannot add attack/use/flight controls',()=>{
 assert.equal(validateAction({op:'control',keys:['forward','jump'],ticks:10,yaw:0}).op,'control')
 for(const input of [{op:'control',keys:['attack'],ticks:10},{op:'control',keys:['forward'],ticks:999},{op:'control',keys:['jump'],ticks:10,yaw:Infinity}])assert.throws(()=>validateAction(input),/bounded movement/)
})


test('physics bobbing preserves a tactical reply but crossing a cell invalidates it',async()=>{
 for(const [delta,accepted] of [[.02,true],[1,false]]){
  let releaseFast,releasePlan,y=64.1
  const c=setup(()=>new Promise(r=>{releasePlan=r}),{tactical:true,
   primitives:{observe:()=>({...observation(),position:[.5,y,.5]}),affordances:()=>[move(1),move(2)]},
   jevChoose:()=>new Promise(r=>{releaseFast=r})})
  c.next();y+=delta;releaseFast({choice:'action_0'});await new Promise(setImmediate)
  assert.equal(Boolean(c.next()),accepted)
  c.close();releasePlan(program([move(1)]));await c.pending
 }
})


test('model context removes duplicate snapshots but preserves failures and verified changes',()=>{
 const inventory=[{name:'oak_planks',count:5}]
 const history=[{type:'action',step:{op:'craft',item:'oak_planks',times:1},ok:true,result:{inventory,crafted:'oak_planks',gained:4,position:[1,64,0]}},{type:'action',step:move(2),ok:false,error:'No path'}]
 const compact=compactPrimitiveHistory(history)
 assert.equal(compact[0].result.inventory,undefined);assert.equal(compact[0].result.gained,4)
 assert.equal(compact[1].error,'No path');assert.equal(history[0].result.inventory,inventory)
 const objective=compactPrimitiveObjective({role:'builder',situation:{inventory,recent_results:history,village:{coolant:8}},beliefs:{events:['large duplicate event'],beliefs:['A remembered hazard'],intentions:['old plan']}})
 assert.equal(objective.role,'builder');assert.deepEqual(objective.situation,{village:{coolant:8}})
 assert.deepEqual(objective.beliefs,['A remembered hazard'])
})


test('vertical swimming does not discard a fresh model plan, but large travel does',async()=>{
 for(const [position,valid] of [[[.5,65.2,.5],true],[[1.5,64,.5],false]]){
  let release,p=position
  const c=setup(()=>new Promise(r=>{release=r}),{primitives:{observe:()=>({...observation(),position:p})}})
  p=[.5,64,.5];c.next();p=position;release(program([move(1)]));await c.pending
  assert.equal(c.status.status,valid?'ready':'error')
  c.close()
 }
})


test('Jev sees failed primitive evidence when selecting the next model program',async()=>{
 const state={primitiveMemory:{history:[{type:'action',step:move(1),ok:false,error:'NoPath'}]}}
 let stance
 const c=setup(async()=>({intention:'Find another route',alternatives:[{reason:'repeat',steps:[move(1)]},{reason:'go elsewhere',steps:[move(2)]}]}),{
  state,jevChoose:async input=>{stance=input.stance;return {choice:'program_2'}}})
 c.next();await c.pending
 assert.match(stance.verified_history[0].error,/NoPath/)
 c.close()
})


test('Jev server-confirmed digging satisfies an overlapping Kimi step without crediting Kimi',async()=>{
 let release,removed=false
 const dig={op:'dig',target:[1,64,0],expect:'stone'},events=[]
 const observe=()=>({...observation(),blocks:[{name:removed?'air':'stone',positions:[[1,64,0]]},{name:'air',positions:[[2,64,0]]}]})
 const c=setup(()=>new Promise(r=>{release=r}),{tactical:true,primitives:{observe,affordances:()=>[dig,move(2)]},
  jevChoose:async()=>({choice:'action_0'}),log:(event,data)=>events.push({event,...data})})
 c.next();await new Promise(setImmediate)
 const tactical=c.next();assert.equal(tactical.source,'jev_primitives')
 release(program([dig,move(2)]));await c.pending
 removed=true;c.record(tactical.step,{result:{removed:{name:'stone',position:[1,64,0]}}})
 assert.deepEqual(c.next().step,move(2))
 assert.ok(events.some(e=>e.event==='program_step_reconciled'&&e.source==='jev_primitives'))
 assert.equal(events.some(e=>e.event==='program_invalidated'),false)
 c.close()
})

test('a failing Jev step in flight cannot cancel a newly ready Kimi program',async()=>{
 let release
 const dig={op:'dig',target:[1,64,0],expect:'stone'}
 const c=setup(()=>new Promise(r=>{release=r}),{tactical:true,
  primitives:{observe:observation,affordances:()=>[dig,move(2)]},
  jevChoose:async()=>({choice:'action_0'})})
 c.next();await new Promise(setImmediate)
 const tactical=c.next();release(program([move(1)]));await c.pending
 c.record(tactical.step,{error:Error('Jev target changed')})
 assert.deepEqual(c.next().step,move(1));c.close()
})


test('Jev avoids reversing a recent verified block change while Kimi remains free to plan it',async()=>{
 for(const [past,step] of [
  [{op:'place',target:[1,64,0],item:'stone'},{op:'dig',target:[1,64,0],expect:'stone'}],
  [{op:'dig',target:[1,64,0],expect:'stone'},{op:'place',target:[1,64,0],item:'stone'}],
 ]){
  let release,options
  const result=past.op==='place'?{placed:{name:'stone',position:past.target}}:{removed:{name:'stone',position:past.target}}
  const state={primitiveMemory:{history:[{at:Date.now(),type:'action',source:'jev_primitives',step:past,ok:true,result}]}}
  const c=setup(()=>new Promise(r=>{release=r}),{tactical:true,state,
   primitives:{observe:observation,affordances:()=>[step,move(1),move(2)]},
   jevChoose:async input=>{options=input.options;return{choice:'action_0'}}})
  c.next();await new Promise(setImmediate)
  assert.equal(Object.values(options).some(v=>v.includes(`\"op\":\"${step.op}\"`)),false)
  c.close();release(program([step]));await c.pending
 }
})


test('one unobserved alternative does not discard a feasible authored program',()=>{
 const response={intention:'Clear an obstacle',alternatives:[
  {reason:'distant guess',steps:[move(20)]},{reason:'observed route',steps:[move(1)]}]}
 const result=validatePrograms(response,observation())
 assert.deepEqual(result.alternatives.map(p=>p.id),['program_2'])
 assert.equal(result.rejectedAlternatives[0].alternative,1)
 assert.match(result.rejectedAlternatives[0].error,/not in the supplied local observation/)
})
