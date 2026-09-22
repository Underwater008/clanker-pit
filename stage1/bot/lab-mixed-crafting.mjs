// Scripted mixed-plank recipes against vanilla; isolated lab ports only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { craftableRecipe, craftConfirmed } from './crafting.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'CraftMixLab', auth: 'offline' })
const timer = setTimeout(() => { console.error('MIXED_CRAFT_LAB_TIMEOUT'); bot.quit(); rcon.end(); process.exitCode = 1 }, 60000)
try {
  await once(bot, 'spawn')
  for (const command of [
    'gamemode survival CraftMixLab',
    'fill 38 -60 -2 43 -56 3 air', 'fill 38 -61 -2 43 -61 3 grass_block',
    'setblock 40 -60 1 crafting_table', 'tp CraftMixLab 40.5 -60 -0.5',
  ]) await rcon.send(command)
  await sleep(1000)
  for (const [output, held] of [
    ['wooden_pickaxe', { birch_planks: 1, oak_planks: 2, stick: 4 }],
    ['crafting_table', { birch_planks: 2, oak_planks: 2 }],
    ['stick', { birch_planks: 1, oak_planks: 1 }],
  ]) {
    await rcon.send('clear CraftMixLab')
    for (const [name, count] of Object.entries(held)) await rcon.send(`give CraftMixLab ${name} ${count}`)
    await sleep(250)
    const item = bot.registry.itemsByName[output]
    const table = output === 'wooden_pickaxe' ? bot.blockAt(new Vec3(40, -60, 1)) : null
    assert.equal(bot.recipesFor(item.id, null, 1, table).length, 0, 'Reproduce original single-species recipe failure')
    const recipe = craftableRecipe(bot, item, table)
    assert.ok(recipe)
    await craftConfirmed(bot, recipe, 1, table)
    assert.ok(bot.inventory.items().some((item) => item.name === output && item.count === recipe.result.count))
    const authoritative = await rcon.send('data get entity CraftMixLab Inventory')
    assert.ok(authoritative.includes(`minecraft:${output}`), 'RCON must confirm the real output')
    console.log(JSON.stringify({ event: 'MIXED_CRAFT_VERIFIED', output, count: recipe.result.count }))
  }
  console.log(JSON.stringify({ event: 'LAB_MIXED_CRAFTING_PASS' }))
} finally {
  clearTimeout(timer)
  bot.quit(); rcon.end()
}
