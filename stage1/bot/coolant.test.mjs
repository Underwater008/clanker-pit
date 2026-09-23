import test from 'node:test'
import assert from 'node:assert/strict'
import { coolantSource, coolantCells, coolantPack, isCoolantBucket, COOLANT_ID } from './coolant.mjs'
import { structuralBlock, bestEquipment } from './survival.mjs'

test('only server-tagged water buckets count as expedition coolant', () => {
  const components = [{ type: 'custom_data', data: { type: 'compound', value: {
    clanker_coolant: { type: 'string', value: COOLANT_ID },
  } } }]
  assert.equal(isCoolantBucket({ name: 'water_bucket', components }), true)
  assert.equal(isCoolantBucket({ name: 'bucket', components }), false)
  assert.equal(isCoolantBucket({ name: 'water_bucket' }), false)
  assert.equal(isCoolantBucket({ name: 'water_bucket', components: [{ type: 'custom_name', data: 'Cryo Coolant' }] }), false)
})
test('remote springs remain bounded and legacy rounds do not move implicitly', () => {
  const flag = { x: 0, y: 64, z: 0 }
  assert.equal(coolantSource(flag, null), null)
  for (const source of [{ x: 0, y: 64, z: 12 }, { x: 0, y: 64, z: 151 }, { x: 0, y: NaN, z: 120 }])
    assert.throws(() => coolantSource(flag, source))
  const source = coolantSource(flag, { x: 0, y: 65, z: 120 })
  assert.equal(coolantCells(source).length, 4)
  const pack = coolantPack(flag, source)
  assert.equal(JSON.parse(pack['pack.mcmeta']).pack.pack_format, 48)
  assert.match(pack['data/clanker_coolant/function/tick.mcfunction'], /scores=\{clanker_fill=1\.\.\}/)
  assert.match(pack['data/clanker_coolant/function/tick.mcfunction'], /positioned 0.5 65.5 120.5/)
})
test('collision blocks are not automatically suitable construction', () => {
  for (const name of ['oak_leaves', 'azalea_leaves', 'sand', 'gravel', 'cactus', 'chest', 'crafting_table'])
    assert.equal(structuralBlock({ name, boundingBox: 'block' }), false, name)
  for (const name of ['cobblestone', 'oak_planks', 'stone_bricks', 'dirt'])
    assert.equal(structuralBlock({ name, boundingBox: 'block' }), true, name)
  assert.equal(structuralBlock(null), false)
})
test('equipment selection never downgrades a carried iron or diamond tool', () => {
  const items = ['wooden_pickaxe', 'stone_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'].map((name) => ({ name }))
  assert.equal(bestEquipment(items, '_pickaxe').name, 'diamond_pickaxe')
})
