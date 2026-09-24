// Isolated fixtures only; no model requests or production state.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival, countItems } from './survival.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
let bot, skills
const timeout = setTimeout(() => { bot?.quit(); rcon.end(); process.exitCode = 1 }, 150000)
const command = async (text) => rcon.send(text)
try {
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'PersonalLab', auth: 'offline' })
  const state = { camp: null, recent: [], cooldowns: {}, plan: { goal: 'personal_progress' }, role: 'farmer' }
  skills = installSurvival(bot, state, () => {}, { village: {
    flag: new Vec3(0, -57, 0), lotIndex: 0, summary: () => ({ water: { fed: 20 } }), isEnemyPlayer: () => false,
  } })
  await once(bot, 'spawn')
  for (const c of [
    'gamerule doMobSpawning false', 'time set noon', 'gamemode survival PersonalLab', 'clear PersonalLab',
    'fill -16 -60 -16 20 -50 20 air', 'fill -16 -60 -16 20 -57 20 stone',
    'fill 10 -60 8 11 -57 9 air', 'tp PersonalLab 10.5 -56 6.5',
    'give PersonalLab dirt 4', 'give PersonalLab iron_pickaxe', 'give PersonalLab coal 2',
    'setblock 14 -56 6 diamond_ore', 'setblock 14 -56 8 gold_ore',
    'setblock 8 -56 6 furnace', 'setblock 8 -56 5 crafting_table',
  ]) await command(c)
  await sleep(1200)
  for (let i = 0; i < 4; i++) {
    assert.ok(skills.candidates(skills.observation()).repair_blast_hole)
    const result = await skills.execute('repair_blast_hole', { source: 'scripted_lab' })
    assert.equal(result.repairedHole, true)
    const p = result.position
    assert.match(await command(`execute if block ${p.x} ${p.y} ${p.z} dirt`), /Test passed/)
  }
  await sleep(300) // Inventory slot packets may follow the confirmed block update.
  assert.equal(countItems(bot.inventory.items(), 'dirt'), 0)
  assert.match(await command('execute if block 10 -59 8 air'), /Test passed/)
  for (const action of ['mine_diamond_ore', 'mine_gold_ore', 'smelt_gold']) {
    assert.ok(skills.candidates(skills.observation())[action], `${action} offered`)
    const result = await skills.execute(action, { source: 'scripted_lab' })
    console.log(JSON.stringify({ action, result }))
  }
  assert.equal(countItems(bot.inventory.items(), 'diamond'), 1)
  assert.equal(countItems(bot.inventory.items(), 'gold_ingot'), 1)
  // Labeled grant tests crafting/equipping; it is not autonomous mining evidence.
  await command('give PersonalLab diamond 3')
  await sleep(400)
  assert.ok(skills.candidates(skills.observation()).craft_diamond_boots)
  await skills.execute('craft_diamond_boots', { source: 'scripted_lab' })
  await skills.execute('equip_armor', { source: 'scripted_lab' })
  assert.equal(bot.inventory.slots[8]?.name, 'diamond_boots')
  assert.match(await command('data get entity PersonalLab Inventory'), /diamond_boots/)
  console.log(JSON.stringify({ event: 'PERSONAL_LAB_PASS', floorBlocks: 4, deepCavityPreserved: true,
    diamondMined: 1, goldSmelted: 1, worn: 'diamond_boots', personal: state.personal }))
} finally {
  clearTimeout(timeout)
  skills?.stop(); bot?.quit(); rcon.end()
}
