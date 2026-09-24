import { Vec3 } from 'vec3'

const hazards = new Set(['water', 'lava', 'fire', 'soul_fire', 'cactus', 'magma_block',
  'powder_snow', 'sweet_berry_bush', 'sand', 'red_sand', 'gravel'])
const solid = (b) => b?.boundingBox === 'block'

// A small local walk graph. No RCON, hidden-world survey, excavation, towers,
// or teleports. Returning explicit destinations lets the planner choose an
// approach rather than merely narrating an opaque "explore" skill.
export function localRecoveryRoutes(bot, maxSteps = 5) {
  const origin = bot.entity.position.floored()
  const seen = new Set([origin.toString()]), queue = [{ p: origin, steps: 0 }]
  const regions = new Map()
  const standable = (p) => {
    const floor = bot.blockAt(p.offset(0, -1, 0)), feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0))
    return floor && feet && head && solid(floor) && !solid(feet) && !solid(head) &&
      ![floor, feet, head].some((b) => hazards.has(b.name))
  }
  for (let i = 0; i < queue.length && i < 96; i++) {
    const { p, steps } = queue[i]
    if (steps >= maxSteps) continue
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const next = p.offset(dx, dy, dz)
        if (Math.abs(next.y - origin.y) > 2 || seen.has(next.toString()) || !standable(next)) continue
        // A rising step needs headroom above the starting square too.
        if (dy === 1 && (!bot.blockAt(p.offset(0, 2, 0)) || solid(bot.blockAt(p.offset(0, 2, 0))))) continue
        seen.add(next.toString()); queue.push({ p: next, steps: steps + 1 })
        const x = next.x - origin.x, z = next.z - origin.z
        const region = Math.abs(x) >= Math.abs(z) ? (x > 0 ? 'east' : 'west') : (z > 0 ? 'south' : 'north')
        const score = Math.hypot(x, z) + Math.max(0, next.y - origin.y)
        if (!regions.has(region) || score > regions.get(region).score)
          regions.set(region, { destination: next, direction: region, steps: steps + 1, score })
        break
      }
    }
  }
  return [...regions.values()].filter(({ destination }) => destination.distanceTo(origin) >= 1)
    .map((route) => ({ ...route, overheadClear: [2, 3, 4].every((y) => {
      const block = bot.blockAt(route.destination.offset(0, y, 0))
      return block && !solid(block) && !hazards.has(block.name)
    }) }))
}

// Dry-ground routes cannot start in a roofed water pocket. Inspect only the
// clanker's own column: a natural overhead block may be opened if the space
// above it is clear. This offers a physical swimming exit without guessing a
// hidden route, disturbing construction, or teleporting the player.
export function localWaterHatch(bot, protectedBlock = () => false) {
  if (!bot.entity.isInWater) return null
  const position = bot.entity.position.floored().offset(0, 2, 0)
  const block = bot.blockAt(position)
  if (!block || !['dirt', 'grass_block', 'stone', 'andesite', 'diorite', 'granite', 'clay'].includes(block.name) ||
      protectedBlock(position) || !bot.canDigBlock(block)) return null
  for (const y of [1, 2]) {
    const above = bot.blockAt(position.offset(0, y, 0))
    if (!above || solid(above) || hazards.has(above.name)) return null
  }
  if (Object.values(bot.entities ?? {}).some((e) => e !== bot.entity && e.position &&
      Math.hypot(e.position.x - position.x - 0.5, e.position.z - position.z - 0.5) < 0.7 &&
      e.position.y >= position.y + 1 && e.position.y < position.y + 3)) return null
  return { position, stateId: block.stateId, name: block.name }
}

export function recoveryKey(kind, position) {
  return `${kind}:${position.x}:${position.y}:${position.z}`
}

export function localContext(bot) {
  const p = bot.entity.position.floored()
  let hash = 2166136261
  const mix = (value) => {
    for (const c of `${value}|`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
  }
  // Exactly 100 cheap loaded-block reads; no findBlocks scan or entity noise.
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -1; y <= 2; y++)
    mix(bot.blockAt(new Vec3(p.x + x, p.y + y, p.z + z))?.stateId ?? 'unloaded')
  const terrain = hash >>> 0
  for (const item of bot.inventory.items().slice().sort((a, b) => a.name.localeCompare(b.name)))
    mix(`${item.name}:${item.count}`)
  return { accessKey: `${bot.game?.dimension ?? 'overworld'}:${p.x},${p.y},${p.z}:${terrain}`, key: `${bot.game?.dimension ?? 'overworld'}:${p.x},${p.y},${p.z}:${hash >>> 0}`, terrain }
}

// Inspect a one-cell barrier and its landing, not an arbitrary dig target.
// Remodeling is opt-in per owned wall cell; containers, beds, floors and roofs
// are never implicitly authorized by their proximity to a trapped clanker.
export function localPassagePlans(bot, { protectedBlock = () => false, remodel = () => false } = {}) {
  const origin = bot.entity.position.floored()
  const natural = new Set(['stone', 'andesite', 'diorite', 'granite', 'dirt', 'grass_block', 'clay'])
  const building = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'dirt'])
  const safe = (p) => { const b = bot.blockAt(p); return b && !hazards.has(b.name) }
  const fullFloor = (p) => {
    const b = bot.blockAt(p)
    return safe(p) && solid(b) && (!b.shapes || b.shapes.some((s) => s.every((v, i) => v === [0, 0, 0, 1, 1, 1][i])))
  }
  const plans = []
  for (const [dx, dz, direction] of [[1, 0, 'east'], [-1, 0, 'west'], [0, 1, 'south'], [0, -1, 'north']]) {
    const doorway = origin.offset(dx, 0, dz), destination = origin.offset(dx * 2, 0, dz * 2)
    if (![doorway, destination].every((p) => fullFloor(p.offset(0, -1, 0)))) continue
    if (![destination, destination.offset(0, 1, 0)].every((p) => safe(p) && !solid(bot.blockAt(p)))) continue
    const clear = []
    let valid = true
    for (const p of [doorway.offset(0, 1, 0), doorway]) {
      const b = bot.blockAt(p)
      if (!safe(p)) { valid = false; break }
      if (!solid(b)) continue
      const owned = remodel(p) && (building.has(b.name) || b.name.endsWith('_planks'))
      if ((!owned && (protectedBlock(p) || !natural.has(b.name))) ||
          ![[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].every(([x,y,z]) => safe(p.offset(x,y,z)))) {
        valid = false; break
      }
      clear.push({ position: p, stateId: b.stateId, name: b.name, remodel: Boolean(owned) })
    }
    if (valid && clear.length) plans.push({ doorway, destination, direction, clear })
  }
  return plans
}
