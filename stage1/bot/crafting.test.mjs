import assert from 'node:assert/strict'
import test from 'node:test'
import minecraftData from 'minecraft-data'
import prismarineRecipe from 'prismarine-recipe'
import { craftableRecipe } from './crafting.mjs'

const registry = minecraftData('1.21.1')
const { Recipe } = prismarineRecipe(registry)
function fixture(held) {
  const inventory = Object.entries(held).map(([name, count]) => ({ name, type: registry.itemsByName[name].id, count }))
  return {
    registry,
    inventory: { items: () => inventory },
    recipesAll(id, metadata, table) { return Recipe.find(id, metadata).filter((recipe) => !recipe.requiresTable || table) },
    recipesFor(id, metadata, count, table) {
      return this.recipesAll(id, metadata, table).filter((recipe) => recipe.delta.every((delta) =>
        delta.count >= 0 || inventory.filter((item) => item.type === delta.id).reduce((n, item) => n + item.count, 0) + delta.count >= 0))
    },
  }
}

test('live mixed-plank inventory yields a concrete wooden pickaxe recipe at a workbench', () => {
  const bot = fixture({ birch_planks: 1, oak_planks: 2, stick: 4 })
  const item = registry.itemsByName.wooden_pickaxe
  assert.equal(bot.recipesFor(item.id, null, 1, {}).length, 0, 'Pinned recipes reproduce the live failure')
  const recipe = craftableRecipe(bot, item, {})
  assert.deepEqual(recipe.inShape[0].map((slot) => registry.items[slot.id].name), ['birch_planks', 'oak_planks', 'oak_planks'])
  assert.equal(recipe.result.id, item.id)
  assert.equal(craftableRecipe(bot, item), undefined, 'A mixed recipe must still require a real workbench')
})

test('mixed workbench and sticks use available species without mutating registry recipes', () => {
  for (const [name, held] of [
    ['crafting_table', { oak_planks: 2, birch_planks: 2 }],
    ['stick', { oak_planks: 1, birch_planks: 1 }],
  ]) {
    const bot = fixture(held), item = registry.itemsByName[name]
    const before = JSON.stringify(Recipe.find(item.id, null))
    const recipe = craftableRecipe(bot, item)
    assert.ok(recipe)
    for (const delta of recipe.delta.filter((d) => d.count < 0))
      assert.ok(-delta.count <= held[registry.items[delta.id].name])
    assert.equal(JSON.stringify(Recipe.find(item.id, null)), before)
  }
})

test('mixed recipes do not invent missing sticks or planks', () => {
  const item = registry.itemsByName.wooden_pickaxe
  for (const held of [{ oak_planks: 1, birch_planks: 1, stick: 4 }, { oak_planks: 2, birch_planks: 1, stick: 1 }])
    assert.equal(craftableRecipe(fixture(held), item, {}), undefined)
})
