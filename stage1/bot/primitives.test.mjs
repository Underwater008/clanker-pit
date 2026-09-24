import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createPrimitives } from './primitives.mjs'
function fixture(protectedBlock=()=>false){
 let removed=false,calls=0
 const client=new EventEmitter()
 const bot={entity:{position:new Vec3(.5,64,.5),eyeHeight:1.62,onGround:true},game:{dimension:'overworld'},health:20,food:20,
  entities:{},inventory:{items:()=>[]},registry:{blocksByName:{air:{minStateId:0}},itemsByName:{}},_client:client,
  pathfinder:{setGoal(){}},clearControlStates(){},stopDigging(){},canDigBlock:()=>true,digTime:()=>1,
  blockAt(p){const stone=p.x===1&&p.y===64&&p.z===0&&!removed;return {name:stone?'stone':p.y<64?'bedrock':'air',stateId:stone?1:0,position:p,boundingBox:stone||p.y<64?'block':'empty'}},
  async dig(){calls++;removed=true},quit(){},
 }
 const executor=createPrimitives({bot,state:{},walk:async()=>{},movements:()=>({}),protectedBlock})
 return {bot,executor,confirm:()=>client.emit('block_change',{location:{x:1,y:64,z:0},type:0}),calls:()=>calls}
}
test('a resolved dig and optimistic local air are not server confirmation',async()=>{
 const {executor}=fixture()
 await assert.rejects(executor.execute({op:'dig',target:[1,64,0],expect:'stone'}),/Server block removal not confirmed/)
})
test('server-confirmed dig removes exactly the requested observed block',async()=>{
 const {bot,executor,confirm,calls}=fixture();const original=bot.dig
 bot.dig=async()=>{await original();confirm()}
 const r=await executor.execute({op:'dig',target:[1,64,0],expect:'stone'})
 assert.deepEqual(r.removed,{position:[1,64,0],name:'stone'});assert.equal(calls(),1)
})
test('protected blocks and changed expectations cannot mutate the world',async()=>{
 const {executor,calls}=fixture(()=>true)
 await assert.rejects(executor.execute({op:'dig',target:[1,64,0],expect:'stone'}),/Protected/)
 await assert.rejects(executor.execute({op:'dig',target:[1,64,0],expect:'dirt'}),/World changed/)
 assert.equal(calls(),0)
})
test('resolved navigation cannot report an arrival that did not happen',async()=>{
 const {executor}=fixture()
 await assert.rejects(executor.execute({op:'move',target:[2,64,0]}),/did not reach/)
})
test('executor serializes operations and stops interrupted digging',async()=>{
 const {bot,executor}=fixture();let reject
 bot.dig=()=>new Promise((_,r)=>{reject=r});bot.stopDigging=()=>reject?.(Error('Stopped'))
 const pending=executor.execute({op:'dig',target:[1,64,0],expect:'stone'})
 await assert.rejects(executor.execute({op:'inspect'}),/unavailable/)
 executor.abort();await assert.rejects(pending,/Stopped/)
})


test('occluded dig targets are rejected before any mining packet',async()=>{
 const {bot,executor,calls}=fixture();bot.canSeeBlock=()=>false
 await assert.rejects(executor.execute({op:'dig',target:[1,64,0],expect:'stone'}),/occluded/)
 assert.equal(calls(),0)
})


test('local observation exposes only currently feasible dig targets',()=>{
 const {bot,executor}=fixture()
 bot.canSeeBlock=()=>false
 assert.deepEqual(executor.observe().feasibleDigTargets,[])
 bot.canSeeBlock=()=>true
 assert.deepEqual(executor.observe().feasibleDigTargets,[{target:[1,64,0],expect:'stone'}])
})


test('walking from water fails with a usable prerequisite',async()=>{
 const {bot,executor}=fixture();bot.entity.isInWater=true
 await assert.rejects(executor.execute({op:'move',target:[2,64,0]}),/control to climb onto dry ground/)
 assert.equal(executor.affordances().some(a=>a.op==='move'),false)
})
test('local observation gives the same cardinal yaw convention as native movement',()=>{
 const {executor}=fixture()
 assert.deepEqual(executor.observe().controls.yawRadians,
  {north:0,west:Math.PI/2,east:-Math.PI/2,south:Math.PI})
})

test('an immersed clanker can mine beside water, but a dry one cannot flood its footing',async()=>{
 const {bot,executor}=fixture()
 const read=bot.blockAt.bind(bot)
 let replaced=false
 bot.blockAt=p=>p.x===1&&p.y===64&&(p.z===1||p.z===0&&replaced)
  ? {name:'water',stateId:9,position:p,boundingBox:'empty'}:read(p)
 await assert.rejects(executor.execute({op:'dig',target:[1,64,0],expect:'stone'}),/Unsafe or unobserved neighbor/)
 bot.entity.isInWater=true
 bot.dig=async()=>{replaced=true;bot._client.emit('block_change',{location:{x:1,y:64,z:0},type:9})}
 const result=await executor.execute({op:'dig',target:[1,64,0],expect:'stone'})
 assert.deepEqual(result.removed,{position:[1,64,0],name:'stone'})
 assert.equal(result.replacedBy,'water')
})
