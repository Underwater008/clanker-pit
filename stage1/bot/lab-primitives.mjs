// Fixed isolated ports. Fixture teleports/grants are never autonomous achievements.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { createActionPlanner, observedPositions } from './action-plan.mjs'
import { plannerFor } from './models.mjs'
import { jevChoose } from './llm.mjs'
const rcon=await Rcon.connect({host:'127.0.0.1',port:25576,password:'clanker-lab'})
const lock='/tmp/clanker-primitive-lab.lock'
const fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid))
let bot,skills,controller
const report=(event,data={})=>console.log(JSON.stringify({event,...data}))
const cases=(process.env.PRIMITIVE_LAB_CASES??'barrier_east,barrier_north,craft,gap,changed').split(',')
const policies=(process.env.PRIMITIVE_LAB_POLICIES??(process.argv.includes('--models')?'model':'scripted,random')).split(',')
assert.ok(!policies.some(p=>['model','hybrid'].includes(p))||process.argv.includes('--models'),'Model calls require --models')
process.once('SIGTERM',()=>{
 controller?.close();skills?.stop();bot?.quit();void rcon.end()
 try{fs.closeSync(fd);if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock)}catch{}
 process.exit(143)
})
const results=[]
const move=target=>({op:'move',target}),dig=target=>({op:'dig',target,expect:'stone'})
let random=42
const pick=a=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return a[Math.floor(random/2**32*a.length)]}
try{
 for(const scenario of cases)for(const policy of policies){
  const state={recent:[],cooldowns:{},plan:{goal:'explore'}}
  bot=mineflayer.createBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'PrimitiveLab',auth:'offline'})
  skills=installSurvival(bot,state,()=>{})
  await once(bot,'spawn')
  for(const command of ['gamerule doMobSpawning false','gamemode survival PrimitiveLab','clear PrimitiveLab','kill @e[type=item]',
   'fill -13 -62 -13 13 -50 13 air','fill -13 -60 -13 13 -60 13 bedrock','tp PrimitiveLab 0.5 -59 0.5'])await rcon.send(command)
  const north=scenario==='barrier_north',d=north?[0,0,-1]:[1,0,0]
  const target=north?[0,-59,-2]:[2,-59,0]
  let objective,script
  if(scenario.startsWith('barrier')||scenario==='changed'){
   for(const command of ['fill -1 -59 -1 1 -57 1 bedrock','fill 0 -59 0 0 -58 0 air',
    `setblock ${d[0]} -59 ${d[2]} stone`,`setblock ${d[0]} -58 ${d[2]} stone`,'give PrimitiveLab stone_pickaxe'])await rcon.send(command)
   objective=`Reach the ground cell ${JSON.stringify(scenario==='changed'?[2,-59,-2]:target)} outside this enclosure. Preserve all bedrock. Use local observations to decide how.`
   script=[{op:'equip',item:'stone_pickaxe'},dig([d[0],-58,d[2]]),dig([d[0],-59,d[2]]),move(target)]
  }else if(scenario==='craft'){
   await rcon.send('give PrimitiveLab oak_log 3')
   objective='Craft one wooden_pickaxe from the inventory materials. You may place a crafting table in clear space. Completion requires the pickaxe in your inventory.'
   script=[{op:'craft',item:'oak_planks',times:3},{op:'craft',item:'stick',times:1},{op:'craft',item:'crafting_table',times:1},{op:'place',target:[2,-59,0],item:'crafting_table'},{op:'craft',item:'wooden_pickaxe',times:1,table:[2,-59,0]}]
  }else{
   await rcon.send('fill 1 -62 -13 2 -60 13 air');await rcon.send('give PrimitiveLab dirt 4')
   objective='Build a two-block dirt walkway by placing dirt at [1,-60,0] and [2,-60,0], then reach [3,-59,0]. Both placed blocks and your arrival are required.'
   script=[{op:'step',dx:.6,dz:0},{op:'place',target:[1,-60,0],item:'dirt'},move([1,-59,0]),{op:'step',dx:.6,dz:0},{op:'place',target:[2,-60,0],item:'dirt'},move([3,-59,0])]
  }
  await sleep(900)
  const start=Date.now(),events=[],outcomes=[];let disturbed=false,planMs=0,plans=0
  if(policy==='model'||policy==='hybrid')controller=createActionPlanner({tactical:policy==='hybrid',planner:plannerFor('PrimitiveLab'),jevChoose,identity:{name:'PrimitiveLab',dispositions:['practical'],current_goal:objective},objective:()=>objective,primitives:skills.primitives,state,
    log:(event,data)=>{events.push({event,...data});report(event,{scenario,...data});if(event==='program_ready'){planMs+=data.durationMs;plans++}}})
  const complete=async()=>{
   if(scenario==='craft')return bot.inventory.items().some(i=>i.name==='wooden_pickaxe')
   const goal=scenario==='changed'?[2,-59,-2]:scenario==='gap'?[3,-59,0]:target
   if(bot.entity.position.distanceTo(new Vec3(...goal).offset(.5,0,.5))>.8)return false
   if(scenario==='gap')return (await rcon.send('execute if block 1 -60 0 dirt')).startsWith('Test passed')&&(await rcon.send('execute if block 2 -60 0 dirt')).startsWith('Test passed')
   return true
  }
  while(outcomes.length<18 && Date.now()-start<240000 && plans<5){
   let step,source=policy
   if(policy==='model'||policy==='hybrid'){
    const next=controller.next();if(!next){await sleep(100);continue}step=next.step;source=next.source
   }else if(policy==='scripted'){step=script.shift();if(!step)break}
   else{
    const choices=skills.primitives.affordances()
    if(!choices.length)break
    step=pick(choices)
   }
   const at=Date.now()
   try{
    const result=await skills.primitives.execute(step,{source});outcomes.push({step,source,ok:true,result,durationMs:Date.now()-at})
    if(scenario==='changed'&&!disturbed&&step.op==='dig'){
     disturbed=true
     for(const c of ['setblock 1 -59 0 bedrock','setblock 1 -58 0 bedrock','setblock 0 -59 -1 stone','setblock 0 -58 -1 stone'])await rcon.send(c)
     await sleep(250);report('FIXTURE_CHANGED',{scenario,policy})
    }
    if(await complete())break
    controller?.record(step,{result})
   }catch(error){outcomes.push({step,source,ok:false,error:String(error),durationMs:Date.now()-at});controller?.record(step,{error})}
   report('PRIMITIVE_OUTCOME',{scenario,policy,...outcomes.at(-1)})
  }
  const passed=await complete();controller?.close();controller=null
  const serverPosition=await rcon.send('data get entity PrimitiveLab Pos')
  const inventory=await rcon.send('data get entity PrimitiveLab Inventory')
  if(passed){
    const coordinates=[...serverPosition.matchAll(/(-?\d+(?:\.\d+)?)d/g)].map(m=>Number(m[1]))
    assert.equal(coordinates.length,3)
    assert.ok(bot.entity.position.distanceTo(new Vec3(...coordinates))<.35,'Server and client positions disagree')
    if(scenario==='craft')assert.match(inventory,/minecraft:wooden_pickaxe/)
  }
  results.push({scenario,policy,passed,wallMs:Date.now()-start,planMs,plans,outcomes,serverPosition,inventory,disturbed})
  report('PRIMITIVE_CASE_RESULT',results.at(-1));skills.stop();bot.quit();await sleep(400)
 }
 report('LAB_PRIMITIVES_COMPLETE',{results,limitation:'Small fixtures and one random seed. Scripted baseline is hand-authored for these tasks. Does not establish general intelligence or broad model superiority.'})
}finally{controller?.close();skills?.stop();bot?.quit();await rcon.end();fs.closeSync(fd);fs.unlinkSync(lock);setTimeout(()=>process.exit(process.exitCode??0),500).unref()}
