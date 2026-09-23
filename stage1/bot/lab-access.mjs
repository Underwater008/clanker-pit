// Isolated Minecraft only. RCON builds fixtures and verifies results, never plans.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { homeBlueprint, homeExtensionBlueprint, homeLot, homeBed } from './village.mjs'
const rcon=await Rcon.connect({host:'127.0.0.1',port:25576,password:'clanker-lab'})
const report=(event,data={})=>console.log(JSON.stringify({event,...data}))
let bot,skills
const timer=setTimeout(()=>{skills?.stop();bot?.quit();rcon.end();process.exitCode=1},300000)
const results=[]
try {
  for (const lot of [2,0,1,3]) {
    const flag=new Vec3(0,-60,0), bed=homeBed(flag,lot), spawn=bed.spawn
    const delta=bed.head.minus(bed.foot), chest=spawn.plus(delta)
    const state={recent:[],cooldowns:{},plan:{goal:'improve_village'},role:'builder'}
    bot=mineflayer.createBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'AccessLab',auth:'offline'})
    skills=installSurvival(bot,state,(event,data)=>report(event,data),{village:{flag,lotIndex:lot,summary:()=>({}),isEnemyPlayer:()=>false}})
    await once(bot,'spawn')
    for(const c of ['gamerule doMobSpawning false','time set noon','gamemode survival AccessLab','clear AccessLab','kill @e[type=minecraft:item]',
      'fill -14 -60 -14 14 -54 14 air','fill -14 -60 -14 14 -60 14 stone',
      ...[...homeBlueprint(homeLot(flag,lot),flag),...homeExtensionBlueprint(flag,lot)].map(p=>`setblock ${p.x} ${p.y} ${p.z} cobblestone`),
      `setblock ${bed.foot.x} ${bed.foot.y} ${bed.foot.z} red_bed[part=foot,facing=${bed.facing}]`,
      `setblock ${bed.head.x} ${bed.head.y} ${bed.head.z} red_bed[part=head,facing=${bed.facing}]`,
      `setblock ${chest.x} ${chest.y} ${chest.z} chest`,
      `item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with minecraft:diamond 3`,
      'give AccessLab stone_pickaxe',`tp AccessLab ${spawn.x+.5} ${spawn.y} ${spawn.z+.5}`]) await rcon.send(c)
    await sleep(800)
    await assert.rejects(skills.execute('explore'),/path|goal|deadline|navigation/i)
    await assert.rejects(skills.execute('explore'),/path|goal|deadline|navigation/i)
    const options=skills.candidates(skills.observation())
    assert.ok(Object.keys(options).some(k=>k.startsWith('recover_passage:')),JSON.stringify(options))
    assert.equal(options.expand_home,undefined,'Construction must wait for access')
    let choice=Object.keys(options).find(k=>k.startsWith('recover_passage:')), source='scripted'
    if(process.argv.includes('--models') && lot===2){
      const {plannerFor}=await import('./models.mjs')
      const start=Date.now()
      const plan=await plannerFor('AccessLab').plan({identity:{name:'AccessLab',dispositions:['practical'],current_goal:'Get out of the blocked home and resume useful work; preserve supplies and the bed.'},observation:skills.observation(),memoryContext:{progress:skills.progress()},goals:{improve_village:'Improve the village'},actions:options,capabilities:skills.capabilities()})
      assert.equal(plan.error,undefined,JSON.stringify(plan)); assert.ok(plan.nextAction?.startsWith('recover_passage:'),JSON.stringify(plan))
      choice=plan.nextAction;source='planner';report('MODEL_PLAN',{plan,latencyMs:Date.now()-start})
    }
    const result=await skills.execute(choice,{source})
    assert.equal(result.openedPassage,true)
    const server=await rcon.send('data get entity AccessLab Pos')
    const coords=[...server.matchAll(/(-?\d+(?:\.\d+)?)d/g)].map(m=>Number(m[1]))
    assert.equal(coords.length,3);assert.ok(bot.entity.position.distanceTo(new Vec3(...coords))<.3)
    const contents=await rcon.send(`data get block ${chest.x} ${chest.y} ${chest.z} Items`)
    assert.match(contents,/diamond/);assert.match(contents,/3/)
    assert.match(await rcon.send(`execute if block ${bed.foot.x} ${bed.foot.y} ${bed.foot.z} red_bed`),/^Test passed/)
    assert.match(await rcon.send(`execute if block ${spawn.x} ${spawn.y+2} ${spawn.z} cobblestone`),/^Test passed/)
    assert.equal(state.accessOpenings.length,2)
    for(const key of state.accessOpenings){const p=key.replace(/[()]/g,'').split(',').map(Number);assert.match(await rcon.send(`execute if block ${p.join(' ')} air`),/^Test passed/)}
    // Real reconnect/reload: construction must not restore the remembered doorway.
    const saved=JSON.parse(JSON.stringify(state));skills.stop();bot.quit();await sleep(350)
    bot=mineflayer.createBot({host:'127.0.0.1',port:25566,version:'1.21.1',username:'AccessLab',auth:'offline'})
    skills=installSurvival(bot,saved,()=>{},{village:{flag,lotIndex:lot,summary:()=>({}),isEnemyPlayer:()=>false}})
    await once(bot,'spawn');await sleep(600)
    await rcon.send('give AccessLab cobblestone 16');await sleep(300)
    const built=await skills.execute('expand_home',{source:'scripted'})
    assert.equal(built.placed,0)
    assert.equal(skills.observation().village.my_home_upgrade.complete,true)
    for(const key of saved.accessOpenings){const p=key.replace(/[()]/g,'').split(',').map(Number);assert.match(await rcon.send(`execute if block ${p.join(' ')} air`),/^Test passed/)}
    results.push({lot,choice,source,moved:result.moved,server,suppliesPreserved:true,roofPreserved:true,bedPreserved:true,doorwaySurvivesReload:true})
    report('ACCESS_CASE_PASS',results.at(-1));skills.stop();bot.quit();await sleep(350)
  }
  report('LAB_ACCESS_COMPLETE',{results,limitation:'Bounded Minecraft skills. A model choice is not evidence of superiority over scripted or random choices.'})
}finally{clearTimeout(timer);skills?.stop();bot?.quit();await rcon.end(); setTimeout(()=>process.exit(process.exitCode ?? 0),500).unref()}
