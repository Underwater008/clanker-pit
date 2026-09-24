import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { inspectVegetation, safeSaplingSite, naturalLeaf } from './vegetation.mjs'

function scene() {
  const blocks = new Map()
  const put = (x,y,z,name,persistent=false) => {
    const position = new Vec3(x,y,z)
    blocks.set(position.toString(), { name, position, getProperties: () => ({ persistent }) })
  }
  const bot = { blockAt: (p) => blocks.get(p.toString()) ?? { name: 'air', position: p },
    findBlocks: ({matching}) => [...blocks.values()].filter(matching).map((b) => b.position) }
  put(0,64,3,'dirt')
  for(let y=65;y<=68;y++) put(0,y,3,'oak_log')
  put(0,69,3,'oak_leaves')
  return { bot, put, blocks, flag: new Vec3(0,64,0) }
}
test('natural trunks stay recognized after the stump is cut; placed timber and leaves stay', () => {
  const { bot, put, blocks, flag } = scene()
  put(3,65,3,'oak_log')
  put(2,68,3,'oak_leaves',true)
  const first = inspectVegetation(bot,flag)
  assert.equal(first.known.length,4)
  assert.equal(first.targets.length,5)
  blocks.delete(new Vec3(0,65,3).toString())
  const next = inspectVegetation(bot,flag,{known:first.known})
  assert.equal(next.known.length,3)
  assert.equal(next.targets.length,4)
  assert.ok(!next.targets.some((b) => b.position.x!==0))
})
test('unknown leaves, protected construction, and distant trees are never clearance targets', () => {
  const {bot,put,flag} = scene()
  const result=inspectVegetation(bot,flag,{protectedBlock:()=>true})
  assert.equal(result.known.length,0)
  assert.ok(result.targets.every(naturalLeaf))
  put(25,65,3,'oak_leaves')
  assert.equal(inspectVegetation(bot,flag).targets.length,5)
  assert.equal(naturalLeaf({name:'oak_leaves'}),false)
})
test('saplings cannot recreate canopy over the Server or guest approach', () => {
  const flag=new Vec3(0,64,0)
  assert.equal(safeSaplingSite(new Vec3(0,65,3),flag),false)
  assert.equal(safeSaplingSite(new Vec3(16,65,0),flag),false)
  assert.equal(safeSaplingSite(new Vec3(0,65,30),flag),false)
  assert.equal(safeSaplingSite(new Vec3(20,65,0),flag),true)
})
