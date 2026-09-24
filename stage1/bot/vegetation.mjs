import { Vec3 } from 'vec3'
import { WALL_RADIUS } from './village.mjs'

export const naturalLeaf = (block) => block?.name?.endsWith('_leaves') &&
  [false, 'false'].includes(block.getProperties?.().persistent)
const logBlock = (block) => Boolean(block?.name?.endsWith('_log') && !block.name.startsWith('stripped_'))
const soil = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mud', 'moss_block'])

export function inVillageClearance(p, flag) {
  return Math.abs(p.x - flag.x) <= WALL_RADIUS + 4 && Math.abs(p.z - flag.z) <= WALL_RADIUS + 4 &&
    p.y > flag.y && p.y <= flag.y + 14
}

export function safeSaplingSite(p, flag) {
  if (!flag) return true
  const x = Math.abs(p.x - flag.x), z = p.z - flag.z
  // Keep future crowns outside the village and off the guest approach road.
  return Math.max(x, Math.abs(z)) > WALL_RADIUS + 9 && !(x <= 6 && z >= 0 && z <= WALL_RADIUS + 28)
}

// Proof uses loaded local blocks only: a soil-rooted trunk and natural leaves.
// Remember verified log cells before cutting so the remaining crown/branches
// remain eligible after the first log is gone. Placed/stripped timber is excluded.
export function inspectVegetation(bot, flag, { known = [], protectedBlock = () => false } = {}) {
  const observed = bot.findBlocks({ matching: (b) => logBlock(b) || naturalLeaf(b),
    maxDistance: 24, count: 512 }).map((p) => bot.blockAt(p))
    .filter((b) => b && inVillageClearance(b.position, flag))
  const remembered = new Map(known.filter((b) => {
    const p = new Vec3(b.x, b.y, b.z)
    return inVillageClearance(p, flag) && bot.blockAt(p)?.name === b.name && !protectedBlock(p)
  }).map((b) => [new Vec3(b.x, b.y, b.z).toString(), b]))
  for (const block of observed) {
    if (!logBlock(block) || protectedBlock(block.position)) continue
    let root = block.position, height = 1
    while (height < 14 && logBlock(bot.blockAt(root.offset(0, -1, 0)))) {
      root = root.offset(0, -1, 0); height++
    }
    if (!soil.has(bot.blockAt(root.offset(0, -1, 0))?.name)) continue
    let top = root
    while (top.y - root.y < 14 && logBlock(bot.blockAt(top.offset(0, 1, 0)))) top = top.offset(0, 1, 0)
    if (top.y === root.y) continue
    let crown = false
    for (let x = -2; x <= 2 && !crown; x++) for (let z = -2; z <= 2 && !crown; z++)
      for (let y = 0; y <= 2 && !crown; y++) crown = naturalLeaf(bot.blockAt(top.offset(x, y, z)))
    if (!crown) continue
    // Include only connected observed logs, bounded to this loaded crown.
    const queue = [root], seen = new Set()
    while (queue.length && seen.size < 128) {
      const p = queue.shift(), key = p.toString()
      if (seen.has(key)) continue
      seen.add(key)
      const b = bot.blockAt(p)
      if (!logBlock(b) || !inVillageClearance(p, flag) || protectedBlock(p)) continue
      remembered.set(key, { x: p.x, y: p.y, z: p.z, name: b.name })
      for (const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) queue.push(p.offset(x,y,z))
    }
  }
  const targets = observed.filter((b) => naturalLeaf(b) || remembered.has(b.position.toString()))
  return { targets, known: [...remembered.values()].slice(-256) }
}
