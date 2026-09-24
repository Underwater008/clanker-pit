import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { localPassagePlans, localWaterHatch, localContext } from './recovery.mjs'
import { createProgressMemory } from './progress.mjs'

function scene() {
  const cells = new Map()
  const put = (x,y,z,name) => cells.set(`${x},${y},${z}`, name)
  const bot = { entity: { position: new Vec3(.5,64,.5) }, inventory: { items: () => [] },
    blockAt(p) { const name = cells.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 64 ? 'stone' : 'air')
      return { position:p, name, stateId:name, boundingBox:name === 'air' ? 'empty' : 'block' } } }
  return {bot,put}
}
test('passages generalize across rotated barriers and reject protected construction', () => {
  for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const {bot,put} = scene()
    for (const y of [64,65]) put(dx,y,dz,'stone')
    assert.equal(localPassagePlans(bot).length, 1)
    assert.equal(localPassagePlans(bot,{protectedBlock:()=>true}).length,0)
    for (const y of [64,65]) put(dx,y,dz,'cobblestone')
    assert.equal(localPassagePlans(bot).length,0)
    const plans = localPassagePlans(bot,{protectedBlock:()=>true,remodel:p=>p.x===dx && p.z===dz})
    assert.equal(plans.length,1)
    assert.ok(plans[0].destination.equals(new Vec3(dx*2,64,dz*2)))
    assert.ok(plans[0].clear.every(b=>b.remodel))
  }
})
test('even remodeling cannot remove beds, supplies, unknown space or expose hazards', () => {
  for (const obstruction of ['chest','red_bed','furnace','bedrock']) {
    const {bot,put} = scene(); put(1,64,0,obstruction)
    assert.equal(localPassagePlans(bot,{remodel:()=>true}).length,0)
  }
  for (const hazard of ['water','lava','sand','gravel']) {
    const {bot,put} = scene(); put(1,64,0,'stone'); put(1,65,0,'stone'); put(1,66,0,hazard)
    assert.equal(localPassagePlans(bot).length,0)
  }
  const {bot,put} = scene(); put(1,64,0,'stone')
  const read=bot.blockAt; bot.blockAt=p=>p.x===2?null:read(p)
  assert.equal(localPassagePlans(bot).length,0)
})
test('roofed water pocket offers only a safe natural overhead hatch', () => {
  const { bot, put } = scene()
  bot.entity.position = new Vec3(.5, 61.2, .5)
  bot.entity.isInWater = true
  bot.canDigBlock = () => true
  put(0,61,0,'water'); put(0,62,0,'water'); put(0,63,0,'grass_block')
  assert.ok(localWaterHatch(bot)?.position.equals(new Vec3(0,63,0)))
  assert.equal(localWaterHatch(bot, () => true), null, 'construction is protected')
  put(0,63,0,'oak_planks')
  assert.equal(localWaterHatch(bot), null, 'a player-built ceiling is preserved')
  put(0,63,0,'dirt'); put(0,64,0,'lava')
  assert.equal(localWaterHatch(bot), null, 'a hazardous exit is rejected')
  put(0,64,0,'air'); bot.entity.isInWater = false
  assert.equal(localWaterHatch(bot), null, 'the option requires a water pocket')
})
test('access failures outlive cooldowns and crafting; changed terrain invalidates them', () => {
  const {bot,put}=scene(), state={}; let time=1000
  let memory=createProgressMemory(state,{now:()=>time}), local=localContext(bot)
  for(let i=0;i<2;i++) memory.record({context:local.key,accessContext:local.accessKey,action:'explore',before:bot.entity.position,after:bot.entity.position,ok:false,changed:true,error:'Navigation no path'})
  time+=3600000
  memory=createProgressMemory(JSON.parse(JSON.stringify(state)),{now:()=>time})
  bot.inventory.items=()=>[{name:'planks',count:4}]
  assert.equal(memory.accessBlocked(localContext(bot).accessKey),true)
  put(1,64,0,'stone')
  assert.equal(memory.accessBlocked(localContext(bot).accessKey),false)
})
