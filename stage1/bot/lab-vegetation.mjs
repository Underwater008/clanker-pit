// Only isolated MC 25566/RCON 25576. Fixtures and action choices are scripted;
// proof is actual changed blocks, not autonomous planner behavior.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
const rcon=await Rcon.connect({host:'127.0.0.1',port:25576,password:'clanker-lab',timeout:5000})
let bot,skills,owned=false
try {
  await rcon.send('forceload add 1200 1200')
  await sleep(1000)
  // A fresh dedicated lab server is required; refuse to replace occupied cells.
  for(let x=1200;x<=1207;x++) for(let z=1200;z<=1207;z++)
    for(let y=250;y<=256;y++) assert.match(await rcon.send(`execute if block ${x} ${y} ${z} air`),/^Test passed/)
  owned=true
  await rcon.send('fill 1200 250 1200 1207 250 1207 dirt')
  await rcon.send('fill 1200 251 1205 1200 254 1205 oak_log')
  await rcon.send('setblock 1200 255 1205 oak_leaves[persistent=false,distance=1]')
  await rcon.send('setblock 1202 252 1203 oak_leaves[persistent=true]')
  await rcon.send('setblock 1202 251 1202 oak_log')
  bot=mineflayer.createBot({host:'127.0.0.1',port:25566,username:'VegetationLab',version:'1.21.1',auth:'offline'})
  const state={recent:[],cooldowns:{},role:'builder',plan:{goal:'improve_village'}}
  skills=installSurvival(bot,state,()=>{}, {village:{flag:new Vec3(1200,250,1200),lotIndex:0,summary:()=>({}),isEnemyPlayer:()=>false}})
  await once(bot,'spawn')
  for(const cmd of ['tp VegetationLab 1200.5 251 1203.5','give VegetationLab oak_planks 64','give VegetationLab stone_axe','give VegetationLab oak_sapling 4']) await rcon.send(cmd)
  await sleep(1200)
  const obs=skills.observation(), options=skills.candidates(obs)
  assert.equal(options.gather_wood,undefined,'wood stocks are full')
  assert.equal(options.plant_tree,undefined,'do not replant inside village')
  assert.ok(options.clear_village_vegetation,'clearance is independent of wood demand')
  const cleared=[]
  for(let i=0;i<4;i++) {
    const result=await skills.execute('clear_village_vegetation',{source:'scripted'})
    assert.equal(result.clearedVegetation,1)
    const p=result.position
    assert.match(await rcon.send(`execute unless block ${p.x} ${p.y} ${p.z} ${result.block}`),/^Test passed/)
    cleared.push({block:result.block,position:p})
    console.log(JSON.stringify({event:'CLEARED',block:result.block,position:p}))
    await sleep(150)
  }
  assert.match(await rcon.send('execute if block 1202 252 1203 oak_leaves[persistent=true]'),/^Test passed/)
  assert.match(await rcon.send('execute if block 1202 251 1202 oak_log'),/^Test passed/)
  console.log(JSON.stringify({event:'VEGETATION_LAB_PASS',fullWoodStocks:true,replantPrevented:true,placedBlocksPreserved:true,cleared}))
} finally {
  skills?.stop();bot?.quit()
  if(owned) await rcon.send('fill 1200 250 1200 1207 256 1207 air')
  await rcon.send('forceload remove 1200 1200')
  await rcon.end()
}
