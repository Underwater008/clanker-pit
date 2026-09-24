import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'
import { setTimeout as sleep } from 'node:timers/promises'
import { craftableRecipe, craftConfirmed } from './crafting.mjs'
import { validateAction } from './action-plan.mjs'
const { goals } = pathfinderPkg
const vec = (p) => new Vec3(...p)
const xyz = (p) => [p.x, p.y, p.z]
const dangerous = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow', 'sand', 'red_sand', 'gravel'])
const natural = (name) => ['stone','dirt','grass_block','andesite','diorite','granite','clay','coal_ore','iron_ore','copper_ore'].includes(name) || /(_log|_leaves)$/.test(name)
const buildMaterial = (name) => ['dirt','cobblestone','stone','cobbled_deepslate'].includes(name) || /(_planks|_log)$/.test(name)
const solid = (b) => b?.boundingBox === 'block'
const full = (b) => solid(b) && (!b.shapes || b.shapes.some((s) => s.every((v,i) => v === [0,0,0,1,1,1][i])))
const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((n,i) => n+i.count,0)

export function createPrimitives({ bot, state, walk, movements, protectedBlock = () => false, editableConstruction = () => false, onDig = () => {}, emergency = () => false, radius = 4 }) {
  state.primitivePlaced ??= []
  let active = null, stopped = false
  const owned = (b) => state.primitivePlaced.some((p) => p.dimension === bot.game.dimension && p.position.join(',') === xyz(b.position).join(',') && p.name === b.name)
  const editable = (b) => Boolean(b && buildMaterial(b.name) && ((owned(b) && !protectedBlock(b.position)) || editableConstruction(b.position)) || b && !protectedBlock(b.position) && natural(b.name))
  function observe() {
    const origin = bot.entity.position.floored(), groups = new Map(), unloaded = []
    for(let x=-radius;x<=radius;x++) for(let y=-1;y<=3;y++) for(let z=-radius;z<=radius;z++) {
      const p = origin.offset(x,y,z), b = bot.blockAt(p)
      if (!b) { unloaded.push(xyz(p)); continue }
      if (b.name === 'air' && !protectedBlock(p)) continue
      const edit = editable(b), reserved = protectedBlock(p), key = `${b.stateId}:${edit}:${reserved}`
      if (!groups.has(key)) groups.set(key,{name:b.name,stateId:b.stateId,solid:solid(b),editable:edit,reserved,properties:b.getProperties?.() ?? {},positions:[]})
      groups.get(key).positions.push(xyz(p))
    }
    const feasibleDigTargets=[]
    for(const group of groups.values())if(group.editable)for(const at of group.positions){
      const block=bot.blockAt(vec(at))
      try { safeDig(block);if(bot.digTime(block)<=10000)feasibleDigTargets.push({target:at,expect:block.name}) } catch {}
    }
    feasibleDigTargets.sort((a,b)=>vec(a.target).distanceTo(bot.entity.position)-vec(b.target).distanceTo(bot.entity.position))
    return { position: xyz(bot.entity.position), dimension: bot.game.dimension, health: bot.health, food: bot.food,
      body: {inWater:Boolean(bot.entity.isInWater),inLava:Boolean(bot.entity.isInLava),onGround:Boolean(bot.entity.onGround),
        yaw:bot.entity.yaw,pitch:bot.entity.pitch,air:bot.oxygenLevel ?? null},
      held: bot.heldItem?.name ?? null, inventory: bot.inventory.items().map(({name,count})=>({name,count})),
      bounds: {min:xyz(origin.offset(-radius,-1,-radius)),max:xyz(origin.offset(radius,3,radius))},
      unloaded, air: 'Every cell inside bounds absent from blocks and unloaded is observed air.',
      adjacent: Object.fromEntries([[1,0,'east'],[-1,0,'west'],[0,1,'south'],[0,-1,'north']].map(([x,z,d])=>[d,
        [-1,0,1].map(y=>{const p=origin.offset(x,y,z),b=bot.blockAt(p);return {position:xyz(p),name:b?.name??'unloaded',editable:editable(b)}})])),
      blocks:[...groups.values()], feasibleDigTargets:feasibleDigTargets.slice(0,16), entities: Object.values(bot.entities ?? {}).filter(e=>e!==bot.entity && e.position.distanceTo(bot.entity.position)<=radius)
        .map(e=>({id:e.id,name:e.name,position:xyz(e.position)})),
      controls: {forward:'toward yaw',jump:'jump on ground or swim up in water',yawRadians:{south:0,west:Math.PI/2,east:-Math.PI/2,north:Math.PI}},
      limits: { radius, maxReach:4.5, automaticDigging:false, automaticPlacement:false, inspection:'loaded local blocks, not pixels; editable is permission; feasibleDigTargets includes targets currently visible, reachable, and safe to mine' } }
  }
  function inspect(p) {
    if (Math.max(Math.abs(p.x-bot.entity.position.x),Math.abs(p.z-bot.entity.position.z))>radius+1 || Math.abs(p.y-bot.entity.position.y)>4)
      throw Error('Target outside local action range')
    const b=bot.blockAt(p)
    if(!b) throw Error('Target is unloaded')
    return b
  }
  function safeDig(b) {
    if(!editable(b)) throw Error(`Protected or unsupported dig target: ${b.name}`)
    const feet=bot.entity.position.floored()
    if(b.position.x===feet.x && b.position.z===feet.z && b.position.y<feet.y) throw Error('Do not remove your support')
    for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) {
      const n=bot.blockAt(b.position.offset(x,y,z))
      if(!n || dangerous.has(n.name)) throw Error('Unsafe or unobserved neighbor of dig target')
    }
    if(!bot.canDigBlock(b)) throw Error('Dig target is out of reach; move or equip first')
    if(bot.canSeeBlock && !bot.canSeeBlock(b))throw Error('Dig target is occluded; move to see it first')
  }
  let craftCache = {key:null,items:[]}
  function affordances() {
    const obs=observe(), origin=bot.entity.position.floored(), choices=[]
    const add=s=>{if(!choices.some(c=>JSON.stringify(c)===JSON.stringify(s)))choices.push(s)}
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]]) for(const dy of [0,1,-1]) {
      const p=origin.offset(dx,dy,dz),cells=[bot.blockAt(p.offset(0,-1,0)),bot.blockAt(p),bot.blockAt(p.offset(0,1,0))]
      if(!bot.entity.isInWater && cells.every(Boolean)&&full(cells[0])&&!solid(cells[1])&&!solid(cells[2])&&!cells.some(b=>dangerous.has(b.name))){add({op:'move',target:xyz(p)});break}
    }
    for(const target of obs.feasibleDigTargets.slice(0,8))add({op:'dig',...target})
    for(const item of bot.inventory.items().filter(i=>/(pickaxe|axe|shovel|sword)$/.test(i.name)&&i.name!==bot.heldItem?.name).slice(0,4))add({op:'equip',item:item.name})
    const table=obs.blocks.find(b=>b.name==='crafting_table')?.positions.map(vec).find(p=>p.distanceTo(bot.entity.position)<4)
    const key=JSON.stringify(obs.inventory)+JSON.stringify(table)
    if(craftCache.key!==key){
      const bench=table?bot.blockAt(table):null
      craftCache={key,items:Object.values(bot.registry.itemsByName).filter(item=>craftableRecipe(bot,item,bench)).map(i=>i.name).slice(0,16)}
    }
    for(const item of craftCache.items)add({op:'craft',item,times:1,...(table?{table:xyz(table)}:{})})
    // Expose nearby placements, including footing below the edge, without
    // selecting where a structure/bridge should go. The model chooses.
    const materials=bot.inventory.items().filter(i=>buildMaterial(i.name)||['crafting_table','furnace'].includes(i.name)).slice(0,3)
    if(materials.length){
      let count=0
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]])for(const dy of [-1,0]){
        const p=origin.offset(dx,dy,dz)
        if(bot.blockAt(p)?.name!=='air'||protectedBlock(p))continue
        const goal=new goals.GoalPlaceBlock(p,bot.world,{range:4.25,LOS:true})
        if(!goal.getFaceAndRef(bot.entity.position.offset(0,bot.entity.eyeHeight,0)))continue
        for(const item of materials)add({op:'place',target:xyz(p),item:item.name})
        if(++count>=4)break
      }
      if(bot.entity.onGround)for(const [dx,dz] of [[.6,0],[-.6,0],[0,.6],[0,-.6]])add({op:'step',dx,dz})
    }
    // Native movement inputs remain available in water and on partial blocks,
    // where a full-block walking graph is not a usable motor interface.
    const motors=[{op:'control',keys:['jump'],ticks:10}]
    for(const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2])for(const keys of [['forward'],['forward','jump']])
      motors.push({op:'control',keys,ticks:10,yaw})
    return [...motors,...choices.slice(0,48)]
  }
  const abort = () => {
    active?.abort(); bot.pathfinder.setGoal(null); bot.stopDigging(); bot.clearControlStates()
    if(bot.currentWindow) bot.closeWindow(bot.currentWindow)
  }
  async function execute(input) {
    if(stopped || active) throw Error('Primitive executor unavailable')
    const s=validateAction(input), ctl=new AbortController(); active=ctl
    const before=bot.entity.position.clone(), inv=bot.inventory.items().map(({name,count})=>({name,count}))
    let timeout=false
    const check=()=>{if(ctl.signal.aborted || emergency()) throw Error(timeout?'Primitive deadline exceeded':'Primitive interrupted')}
    const timer=setTimeout(()=>{timeout=true;abort();bot.quit('Primitive deadline exceeded; reconnect to release executor')},s.op==='craft'?30000:12000)
    const safety=setInterval(()=>{if(emergency())abort()},100)
    const after=()=>({position:xyz(bot.entity.position),inventory:bot.inventory.items().map(({name,count})=>({name,count}))})
    try {
      check()
      if(s.op==='inspect') return { observed:observe(), progress:false }
      if(s.op==='wait') { await sleep(s.ticks*50,undefined,{signal:ctl.signal});check();return { ...after(),progress:false } }
      if(s.op==='move') {
        if(bot.entity.isInWater)throw Error('Walking from water is unavailable; use control to climb onto dry ground first')
        const p=vec(s.target), feet=inspect(p), head=inspect(p.offset(0,1,0)), floor=inspect(p.offset(0,-1,0))
        if(solid(feet)||solid(head)||!full(floor)||[feet,head,floor].some(b=>dangerous.has(b.name))) throw Error('Move destination lacks safe support/headroom')
        const m=movements(), saved={canDig:m.canDig,allow1by1towers:m.allow1by1towers,canOpenDoors:m.canOpenDoors}
        Object.assign(m,{canDig:false,allow1by1towers:false,canOpenDoors:false})
        try { await walk(new goals.GoalBlock(p.x,p.y,p.z),8000) } finally {Object.assign(m,saved)}
        check()
        if(bot.entity.position.distanceTo(p.offset(.5,0,.5))>.8)throw Error('Server position did not reach target')
        return {...after(),moved:before.distanceTo(bot.entity.position)}
      }
      if(s.op==='control') {
        if(s.yaw!=null)await bot.look(s.yaw,bot.entity.pitch,true)
        for(const key of s.keys)bot.setControlState(key,true)
        try {
          for(let i=0;i<s.ticks;i++){
            check()
            if(bot.entity.isInLava)throw Error('Motor input encountered lava')
            await sleep(50,undefined,{signal:ctl.signal})
          }
        }finally{bot.clearControlStates()}
        check()
        const moved=before.distanceTo(bot.entity.position)
        if(moved<.05)throw Error('Motor input produced no observed movement')
        return {...after(),moved,body:{inWater:Boolean(bot.entity.isInWater),onGround:Boolean(bot.entity.onGround)}}
      }
      if(s.op==='step') {
        if(!bot.entity.onGround || bot.entity.isInWater)throw Error('Fine movement requires dry ground')
        const target=before.offset(s.dx,0,s.dz)
        for(const y of [-1,0,1]) {
          const b=inspect(target.floored().offset(0,y,0))
          if(dangerous.has(b.name))throw Error('Unsafe fine movement destination')
        }
        await bot.look(Math.atan2(-s.dx,-s.dz),0,true)
        bot.setControlState('sneak',true);bot.setControlState('forward',true)
        const deadline=Date.now()+2000
        try {
          while(Math.hypot(bot.entity.position.x-target.x,bot.entity.position.z-target.z)>.08 && Date.now()<deadline){check();await sleep(25)}
        }finally{bot.clearControlStates()}
        await sleep(100);check()
        if(Math.hypot(bot.entity.position.x-target.x,bot.entity.position.z-target.z)>.2 || Math.abs(bot.entity.position.y-before.y)>.25)
          throw Error('Fine movement target not reached safely')
        return {...after(),moved:before.distanceTo(bot.entity.position)}
      }
      if(s.op==='equip') {
        const item=bot.inventory.items().find(i=>i.name===s.item)
        if(!item)throw Error('Equip item missing')
        await bot.equip(item,'hand');check()
        if(bot.heldItem?.name!==s.item)throw Error('Held item not confirmed')
        return {held:s.item,...after()}
      }
      if(s.op==='craft') {
        const item=bot.registry.itemsByName[s.item]
        if(!item)throw Error('Unknown crafting output')
        const table=s.table?inspect(vec(s.table)):null
        if(table && (table.name!=='crafting_table' || table.position.distanceTo(bot.entity.position)>4))throw Error('Workbench not reachable')
        const recipe=craftableRecipe(bot,item,table)
        if(!recipe)throw Error('Ingredients or workbench missing')
        const previous=count(bot,s.item)
        await craftConfirmed(bot,recipe,s.times,table);check()
        const gained=count(bot,s.item)-previous
        if(gained<recipe.result.count*s.times)throw Error('Crafted inventory gain not confirmed')
        return {crafted:s.item,gained,...after()}
      }
      const p=vec(s.target), block=inspect(p)
      if(s.op==='dig'||s.op==='interact') {
        if(block.name!==s.expect)throw Error(`World changed: expected ${s.expect}, observed ${block.name}`)
      }
      if(s.op==='dig') {
        safeDig(block)
        if(bot.digTime(block)>10000)throw Error('Digging takes too long with held tool; equip a better tool')
        let confirmed=false
        const update=packet=>{if(vec([packet.location.x,packet.location.y,packet.location.z]).equals(p) && packet.type===bot.registry.blocksByName.air.minStateId)confirmed=true}
        bot._client.on('block_change',update)
        try {
          await bot.dig(block,true,'raycast');check()
          const deadline=Date.now()+1800
          while(!confirmed && Date.now()<deadline){check();await sleep(50)}
          if(!confirmed || bot.blockAt(p)?.name!=='air')throw Error('Server block removal not confirmed')
        }finally{bot._client.removeListener('block_change',update)}
        onDig(p,block);state.primitivePlaced=state.primitivePlaced.filter(b=>b.position.join(',')!==s.target.join(','))
        return {removed:{position:s.target,name:block.name},...after()}
      }
      if(s.op==='place') {
        if(block.name!=='air'||!(buildMaterial(s.item) || ['crafting_table','furnace'].includes(s.item))||protectedBlock(p))throw Error('Placement requires permitted air and a solid building material')
        const feet=bot.entity.position.floored()
        if(p.x+1>before.x-.3 && p.x<before.x+.3 && p.z+1>before.z-.3 && p.z<before.z+.3 && p.y+1>before.y && p.y<before.y+1.8)
          throw Error('Do not place inside the player collision box')
        const exits=[[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>feet.offset(x,0,z))
          .filter(q=>!solid(bot.blockAt(q))&&!solid(bot.blockAt(q.offset(0,1,0)))&&full(bot.blockAt(q.offset(0,-1,0))))
        if(exits.length===1 && exits[0].x===p.x && exits[0].z===p.z && p.y>=feet.y && p.y<=feet.y+1)
          throw Error('Do not seal the last inspected exit')
        const item=bot.inventory.items().find(i=>i.name===s.item)
        if(!item)throw Error('Placement item missing')
        const goal=new goals.GoalPlaceBlock(p,bot.world,{range:4.25,LOS:true})
        const hit=goal.getFaceAndRef(bot.entity.position.offset(0,bot.entity.eyeHeight,0))
        if(!hit)throw Error('No reachable exposed placement face')
        const previous=count(bot,s.item)
        await bot.equip(item,'hand');check()
        if(bot.heldItem?.name!==s.item)throw Error('Placement held item not confirmed')
        await bot.placeBlock(bot.blockAt(hit.ref),hit.face.scaled(-1));check()
        const deadline=Date.now()+1800
        while(count(bot,s.item)>=previous && Date.now()<deadline){check();await sleep(50)}
        if(bot.blockAt(p)?.name!==s.item || count(bot,s.item)>=previous)throw Error('Placed block and inventory use not confirmed')
        state.primitivePlaced.push({dimension:bot.game.dimension,position:s.target,name:s.item});state.primitivePlaced=state.primitivePlaced.slice(-256)
        return {placed:{position:s.target,name:s.item},...after()}
      }
      if(s.op==='interact') {
        if(!/(_door|_fence_gate|_trapdoor|_button)$/.test(block.name)&&block.name!=='lever')throw Error('Unsupported interaction; no container, fixture or fluid mutation')
        if(block.name.startsWith('iron_')||p.distanceTo(bot.entity.position)>4)throw Error('Interaction not reachable/usable')
        if(bot.heldItem)await bot.unequip('hand')
        await bot.activateBlock(block)
        const deadline=Date.now()+1500
        while(bot.blockAt(p)?.stateId===block.stateId && Date.now()<deadline){check();await sleep(50)}
        check();if(bot.blockAt(p)?.stateId===block.stateId)throw Error('Interaction change not confirmed')
        return {interacted:s.target,stateId:bot.blockAt(p).stateId,...after()}
      }
    } catch(error) { error.primitiveEvidence={before:xyz(before),after:xyz(bot.entity.position),inventoryBefore:inv,inventoryAfter:after().inventory};throw error }
    finally {clearTimeout(timer);clearInterval(safety);active=null;bot.clearControlStates()}
  }
  return {observe,affordances,execute,abort,stop(){stopped=true;abort()}}
}
