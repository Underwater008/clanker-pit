import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { setTimeout as sleep } from 'node:timers/promises'
import { craftConfirmed, craftableRecipe } from './crafting.mjs'
import { coolantSource, coolantCells, isCoolantBucket } from './coolant.mjs'
import { createProgressMemory } from './progress.mjs'
import { inspectVegetation, naturalLeaf, safeSaplingSite } from './vegetation.mjs'
import { localContext, localRecoveryRoutes, localPassagePlans, recoveryKey } from './recovery.mjs'
import {
  wallBlueprint,
  wallReinforcementBlueprint,
  gateBlueprint,
  torchSpots,
  homeBlueprint,
  homeExtensionBlueprint,
  homeLot,
  homeBed,
  HOME_LOTS,
  serverAnatomy,
  patrolNodes,
  farmPlots,
  roadSpots,
  blastHoleTargets,
  WALL_RADIUS,
  isBuildMaterial,
} from './village.mjs'

// One furnace operation at a time across the whole cast (they share this
// process and often share the same furnace): two clankers interleaving
// put/take on one furnace window would mix their iron. Also, opening a
// furnace has no internal timeout, so it must be raced with a deadline.
let furnaceChain = Promise.resolve()
// Clankers in this controller share locally observed resource claims. Holding
// the nearby trunk/drop area through pickup keeps the cast from all mining
// one log while only the closest clanker receives its drop.
const resourceClaims = new Map()

const { pathfinder, Movements, goals } = pathfinderPkg
export const GOALS = {
  build_shelter:
    'Gather wood, craft tools and a workbench, and build a small shelter at camp.',
  equip_tools:
    'Progress from wood to stone tools, then gather useful stone and coal.',
  gather_food:
    'Hunt nearby animals for food and eat available food when hungry.',
  improve_camp:
    'Finish the shelter, add a furnace, plant trees, and stockpile useful materials.',
  explore: 'Scout nearby terrain for new resources, remembering where camp is.',
  protect_server:
    'Keep the Server alive: feed it coolant, guard it from creepers and hostile players, and repair blast damage.',
  build_village:
    'Raise the wall, gate, torches, and your own home around the Server.',
  improve_village:
    'Clear natural trees and canopy around the Server for access and sightlines, repair blast holes, tend wheat, pave lanes, reinforce walls, and enlarge homes within their lots.',
  stockpile_defense:
    'Upgrade stone tools and weapons to iron, craft and wear armor, and supply torches and coolant buckets.',
}
export const countItems = (items, match) =>
  items
    .filter((i) =>
      typeof match === 'string' ? i.name === match : match(i.name),
    )
    .reduce((n, i) => n + i.count, 0)
export const isLog = (n) => /(_log|_stem)$/.test(n)
export const isPlank = (n) => n.endsWith('_planks')
export const isShelterMaterial = (n) => isBuildMaterial(n) || isPlank(n) || n === 'dirt'
const isPick = (n) => n.endsWith('_pickaxe')
const stoneNames = new Set(['stone', 'cobblestone', 'coal_ore'])
const ironOreNames = new Set(['iron_ore', 'deepslate_iron_ore'])
const hostiles = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'pillager',
  'vindicator',
  'phantom',
])
const edible = new Set([
  'apple',
  'bread',
  'carrot',
  'baked_potato',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_cod',
  'cooked_salmon',
  'beef',
  'porkchop',
  'mutton',
  'sweet_berries',
])
const solid = (b) =>
  b && b.boundingBox === 'block' && !['magma_block', 'cactus'].includes(b.name)
// Collision is not construction quality. Leaves, sand, glass panes and
// furniture must never satisfy a wall/roof just because they occupy its cell.
export const structuralBlock = (b) => Boolean(solid(b) &&
  (isShelterMaterial(b.name) || ['grass_block', 'cobbled_deepslate', 'granite',
    'stone_bricks', 'deepslate_bricks', 'bricks', 'obsidian'].includes(b.name)))
const gearTier = (name) => ({ wooden: 1, golden: 1, leather: 1, chainmail: 2,
  stone: 2, iron: 3, diamond: 4, netherite: 5 })[name.split('_')[0]] ?? 0
export function bestEquipment(items, suffix) {
  return items.filter((i) => i.name.endsWith(suffix))
    .sort((a, b) => gearTier(b.name) - gearTier(a.name))[0]
}
const armorSlots = { helmet: ['head', 5], chestplate: ['torso', 6], leggings: ['legs', 7], boots: ['feet', 8] }
function armorUpgrade(bot) {
  for (const [suffix, [destination, slot]] of Object.entries(armorSlots)) {
    const item = bestEquipment(bot.inventory.items(), `_${suffix}`)
    if (item && gearTier(item.name) > gearTier(bot.inventory.slots?.[slot]?.name ?? ''))
      return { item, destination, slot }
  }
  return null
}

export function woodForTools(items, hasWorkbench) {
  const n = (match) => countItems(items, match)
  const needPick = !n(isPick)
  return (hasWorkbench || n('crafting_table') ? 0 : 4) +
    (needPick ? 3 : 0) + (needPick && n('stick') < 2 ? 2 : 0)
}

export function inventoryGains(before, after) {
  const names = new Set(after.map((item) => item.name))
  return [...names].map((name) => ({ name, count: countItems(after, name) - countItems(before, name) }))
    .filter((item) => item.count > 0)
}

const escapeTerrain = new Set([
  'stone', 'andesite', 'diorite', 'granite', 'dirt', 'grass_block', 'clay',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore',
  'lapis_ore', 'diamond_ore', 'emerald_ore',
])
export function escapeDigBudget(digTime) {
  if (!Number.isFinite(digTime) || digTime < 0 || digTime > 16000)
    throw new Error('Escape block would take too long to clear safely')
  return Math.max(2500, digTime + 2000) // Ordinary ore by hand takes 15s; cap work at 18s.
}
export function localEscapePlans(bot, target, protectedBlock = () => false, origin = bot.entity.position.floored()) {
  const hazards = new Set(['water', 'lava', 'sand', 'red_sand', 'gravel'])
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .sort(([ax, az], [bx, bz]) =>
      Math.hypot(origin.x + ax - target.x, origin.z + az - target.z) -
      Math.hypot(origin.x + bx - target.x, origin.z + bz - target.z))
  return directions.map(([dx, dz]) => {
    const step = origin.offset(dx, 0, dz)
    const support = bot.blockAt(step)
    if (!solid(support) || hazards.has(support.name)) return null // Keep a stable stair support.
    const spaces = [origin.offset(0, 2, 0), step.offset(0, 2, 0), step.offset(0, 1, 0)]
    const clear = []
    for (const position of spaces) {
      const block = bot.blockAt(position)
      if (!block || hazards.has(block.name)) return null
      // Never open a fluid pocket, cut under falling terrain, or probe unloaded space.
      for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
        const neighbor = bot.blockAt(position.offset(x, y, z))
        if (!neighbor || hazards.has(neighbor.name)) return null
      }
      if (!solid(block)) continue
      if (!escapeTerrain.has(block.name) || protectedBlock(position)) return null
      clear.push(position)
    }
    return { destination: step.offset(0, 1, 0), clear }
  }).filter(Boolean)
}

// A dry side step can expose a safe stair when water or a cave wall blocks
// every stair from the current square. Inspect only loaded adjacent blocks;
// movement to the selected square is still verified by Pathfinder.
export function localEscapeReposition(bot, target, protectedBlock = () => false) {
  const origin = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const next = origin.offset(dx, 0, dz)
    const floor = bot.blockAt(next.offset(0, -1, 0))
    const feet = bot.blockAt(next), head = bot.blockAt(next.offset(0, 1, 0))
    if (!solid(floor) || ['sand', 'red_sand', 'gravel'].includes(floor.name) ||
        !feet || !head || feet.name === 'water' || head.name === 'water' ||
        feet.name === 'lava' || head.name === 'lava' || solid(feet) || solid(head)) continue
    if (localEscapePlans(bot, target, protectedBlock, next).length) return next
  }
  return null
}

// A displaced respawn can put a clanker on an isolated block above the village.
// Find an inspected one-block step off that perch with a clear, bounded fall.
// Never break the support (which may be player construction) or trust unloaded
// terrain. The actual landing is checked after the movement.
export function safePerchLanding(bot, villageFloorY) {
  const feet = bot.entity.position.floored()
  if (feet.y < villageFloorY + 4 || bot.health < 14) return null
  const support = bot.blockAt(feet.offset(0, -1, 0))
  if (!solid(support)) return null
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of neighbors) {
    const next = feet.offset(dx, 0, dz)
    const ground = bot.blockAt(next.offset(0, -1, 0))
    if (!ground) return null
    if (solid(ground) && !['magma_block', 'cactus'].includes(ground.name)) return null
  }
  for (const [dx, dz] of neighbors) {
    const next = feet.offset(dx, 0, dz)
    if (bot.blockAt(next)?.name !== 'air' ||
        bot.blockAt(next.offset(0, 1, 0))?.name !== 'air') continue
    for (let y = feet.y - 2; y >= feet.y - 9; y--) {
      const block = bot.blockAt(new Vec3(next.x, y, next.z))
      if (!block || ['water', 'lava', 'cactus', 'magma_block'].includes(block.name)) break
      if (!solid(block)) continue
      const drop = feet.y - y - 1
      if (drop >= 3 && drop <= 8)
        return { x: next.x, z: next.z, y: y + 1, drop }
      break
    }
  }
  return null
}

// An isolated workbench or furnace can leave a clanker one block above the
// nearest walkable ground. Pathfinder refuses the village floor boundary here;
// inspect the exact step instead of weakening that boundary for every route.
export function safeLedgeLanding(bot, villageFloorY) {
  const feet = bot.entity.position.floored()
  if (feet.y < villageFloorY + 1 || bot.health < 8 ||
      !solid(bot.blockAt(feet.offset(0, -1, 0)))) return null
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of neighbors) {
    const next = feet.offset(dx, 0, dz)
    const support = bot.blockAt(next.offset(0, -1, 0))
    const body = bot.blockAt(next), head = bot.blockAt(next.offset(0, 1, 0))
    if (solid(support) && body?.name === 'air' && head?.name === 'air') return null
  }
  for (const [dx, dz] of neighbors) {
    const next = feet.offset(dx, 0, dz)
    const support = bot.blockAt(next.offset(0, -2, 0))
    const upper = bot.blockAt(next.offset(0, -1, 0))
    const body = bot.blockAt(next), head = bot.blockAt(next.offset(0, 1, 0))
    if (support && solid(support) &&
        !['cactus', 'magma_block', 'sand', 'red_sand', 'gravel'].includes(support.name) &&
        upper?.name === 'air' && body?.name === 'air' && head?.name === 'air')
      return { x: next.x, y: feet.y - 1, z: next.z, drop: 1 }
  }
  return null
}

// A grown trunk can seal a bed/chest inside a home. Require rooted, vertical
// logs and a leaf crown before clearing a doorway; never touch built fixtures.
export function rootedTreeExit(bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const at = feet.offset(dx, 0, dz)
    const root = bot.blockAt(at.offset(0, -1, 0))
    if (!['dirt', 'grass_block'].includes(root?.name)) continue
    if (![0, 1, 2].every((dy) => isLog(bot.blockAt(at.offset(0, dy, 0))?.name ?? ''))) continue
    let crown = false
    for (let dy = 3; dy <= 7; dy++) {
      for (const [lx, lz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]])
        crown ||= bot.blockAt(at.offset(lx, dy, lz))?.name.endsWith('_leaves') ?? false
    }
    if (crown) return at
  }
  return null
}

function sightToThreat(bot, entity) {
  const from = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const to = entity.position.offset(0, 0.7, 0)
  const distance = from.distanceTo(to)
  for (let d = 0.3; d < distance; d += 0.3) {
    const block = bot.blockAt(from.plus(to.minus(from).scaled(d / distance)))
    if (!block || solid(block)) return false
  }
  return true
}

// goto() in the pinned pathfinder also resolves for an empty failed path.
// Only the current game position can establish that a navigation goal was met.
export function navigationReached(goal, position) {
  const feet = position.floored()
  return goal.isEnd(feet) || goal.isEnd(feet.offset(0, 1, 0))
}

export async function gotoConfirmed(bot, goal) {
  await bot.pathfinder.goto(goal)
  if (!navigationReached(goal, bot.entity.position))
    throw new Error('Navigation ended before reaching the goal')
}

export function navigationGoalSummary(goal) {
  // GoalPlaceBlock contains the entire world cache, and GoalFollow contains
  // a live entity. Serializing the raw goal in a watchdog can freeze the
  // controller long enough to disconnect every clanker.
  const target = goal.pos ?? goal.entity?.position ?? goal
  return {
    type: goal.constructor?.name ?? 'Goal',
    target: { x: target.x, y: target.y, z: target.z },
  }
}

export async function navigateWithRecovery({ bot, goal, run, ms, emergency, log }) {
  const deadline = Date.now() + ms
  let lastError
  try {
    return await run(goal, Math.min(ms, 6000))
  } catch (error) {
    lastError = error
  }
  // Short reflex/scouting moves already choose alternate headings themselves.
  // Longer work routes can sidestep a basin/corner before retrying the target,
  // while sharing the original action deadline and yielding to safety reflexes.
  const target = navigationGoalSummary(goal).target
  if (ms < 7000 || !Number.isFinite(target.x) || !Number.isFinite(target.z)) throw lastError
  const origin = bot.entity.position.clone()
  const angle = Math.atan2(target.z - origin.z, target.x - origin.x)
  for (const offset of [Math.PI / 2, -Math.PI / 2]) {
    let remaining = deadline - Date.now()
    if (remaining < 2500 || emergency()) throw lastError
    const side = new goals.GoalNearXZ(
      origin.x + Math.cos(angle + offset) * 3,
      origin.z + Math.sin(angle + offset) * 3,
      1,
    )
    try {
      const before = bot.entity.position.clone()
      await run(side, Math.min(2500, remaining - 1000))
      if (before.distanceTo(bot.entity.position) < 0.75) continue
      log('navigation_recovery', { position: bot.entity.position, goal: navigationGoalSummary(goal) })
      remaining = deadline - Date.now()
      if (remaining < 500 || emergency()) throw lastError
      return await run(goal, remaining)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export function localShelter(origin, position) {
  return !origin || (
    position.distanceTo(new Vec3(origin.x, origin.y, origin.z)) <= 32 &&
    Math.abs(position.y - origin.y) <= 8
  )
}

export function scoutingTargets(position, angle, turn = 0) {
  // A failed long route must not keep pointing at the same visible tree.
  // Short routes in different directions can get out of corners and basins.
  return [
    { angle: angle + turn * 2.39996, distance: turn ? 5 : 12 },
    { angle: angle + (turn + 1) * 2.39996, distance: 4 },
    { angle: angle + (turn + 2) * 2.39996, distance: 3 },
  ].map(({ angle: bearing, distance }) => ({
    x: Math.floor(position.x + Math.cos(bearing) * distance),
    z: Math.floor(position.z + Math.sin(bearing) * distance),
  }))
}

export function shelterBlueprint(origin) {
  const blocks = []
  for (let y = 0; y < 2; y++)
    for (let x = -1; x <= 1; x++)
      for (let z = -1; z <= 1; z++) {
        if (Math.abs(x) !== 1 && Math.abs(z) !== 1) continue
        if (x === 0 && z === -1) continue // entrance stays clear
        blocks.push(new Vec3(origin.x + x, origin.y + y, origin.z + z))
      }
  // Support the middle early, while its placement face is still exposed.
  for (const [x, z] of [
    [-1, -1],
    [-1, 0],
    [0, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
    [0, -1],
  ])
    blocks.push(new Vec3(origin.x + x, origin.y + 2, origin.z + z))
  return blocks
}

export function installSurvival(bot, state, log, opts = {}) {
  bot.loadPlugin(pathfinder)
  const progress = createProgressMemory(state)
  const blocked = new Map()
  const failedTrees = []
  let scoutStep = 0
  let failedScouts = 0
  let fleeTurn = 0
  let fleeing = false
  let blockedRoutes = 0
  let lastBlockedRoute = 0
  let escapeSession = null
  let escaping = false
  let lastHurtAt = 0
  let skillRevision = 0
  let movements = null
  const claimOwner = Symbol(bot.username)
  const resourceScope = () => opts.resourceScope ?? [
    bot._client?.socket?.remoteAddress ?? process.env.MC_HOST ?? 'local',
    bot._client?.socket?.remotePort ?? process.env.MC_PORT ?? '25565',
    bot.game?.dimension ?? 'overworld',
  ].join(':')
  function resourceBusy(position) {
    const now = Date.now(), scope = resourceScope()
    for (const [key, claim] of resourceClaims) {
      if (claim.until <= now) { resourceClaims.delete(key); continue }
      if (claim.scope !== scope || claim.owner === claimOwner) continue
      const horizontal = Math.hypot(position.x - claim.position.x, position.z - claim.position.z)
      if (horizontal < (claim.tree ? 2.5 : 1.5) &&
          Math.abs(position.y - claim.position.y) < (claim.tree ? 12 : 3)) return true
    }
    return false
  }
  function claimResource(block) {
    if (resourceBusy(block.position)) throw new Error('Resource is being gathered by another clanker')
    const key = Symbol('resource')
    resourceClaims.set(key, {
      owner: claimOwner, scope: resourceScope(), position: block.position.clone(),
      tree: isLog(block.name), until: Date.now() + 45000,
    })
    return () => resourceClaims.delete(key)
  }
  // Village scenario context (null in plain survival mode). The controller
  // supplies the Server's flag position, this bot's home-lot index, a live
  // snapshot of shared village state, and how to recognize guest creeper
  // players so guards can fight them without hidden world knowledge.
  const villageCtx = opts.village ?? null
  const remoteSpring = villageCtx ? coolantSource(villageCtx.flag, villageCtx.coolantSource) : null
  const coolantItem = (item) => remoteSpring ? isCoolantBucket(item) : item?.name === 'water_bucket'
  const layout = villageCtx
    ? {
        flag: villageCtx.flag,
        anatomy: serverAnatomy(villageCtx.flag),
        wall: wallBlueprint(villageCtx.flag),
        wallUpgrade: wallReinforcementBlueprint(villageCtx.flag),
        gate: gateBlueprint(villageCtx.flag),
        torches: torchSpots(villageCtx.flag),
        patrol: patrolNodes(villageCtx.flag),
        farm: farmPlots(villageCtx.flag),
        roads: roadSpots(villageCtx.flag),
        home: homeBlueprint(homeLot(villageCtx.flag, villageCtx.lotIndex), villageCtx.flag),
        homeUpgrade: homeExtensionBlueprint(villageCtx.flag, villageCtx.lotIndex),
      }
    : null
  const villageConstruction = new Set(layout
    ? [
        ...layout.wall,
        ...layout.wallUpgrade,
        ...layout.gate,
        ...HOME_LOTS.flatMap((_, index) => homeBlueprint(
          homeLot(villageCtx.flag, index), villageCtx.flag,
        )),
        ...HOME_LOTS.flatMap((_, index) => homeExtensionBlueprint(villageCtx.flag, index)),
        ...HOME_LOTS.flatMap((_, index) => {
          const bed = homeBed(villageCtx.flag, index)
          return [bed.foot, bed.head]
        }),
        ...layout.farm,
        ...layout.roads,
      ].map((p) => p.toString())
    : [])
  // Only this clanker's extension sidewalls may become deliberate doorways.
  // Exclude every shared/other-home cell, including overlaps between lots.
  const ownExtensionWalls = new Set((layout?.homeUpgrade ?? [])
    .filter((p) => p.y === layout.flag.y + 1 || p.y === layout.flag.y + 2)
    .filter((p) => ![...layout.home, ...layout.wall, ...layout.wallUpgrade, ...layout.gate,
      ...HOME_LOTS.flatMap((_, i) => i === villageCtx.lotIndex ? [] :
        [...homeBlueprint(homeLot(villageCtx.flag, i), villageCtx.flag), ...homeExtensionBlueprint(villageCtx.flag, i)])]
      .some((q) => p.equals(q)))
    .map((p) => p.toString()))
  state.accessOpenings ??= []
  const isOpening = (p) => ownExtensionWalls.has(p.toString()) && state.accessOpenings.includes(p.toString())
  const homePlan = (list) => list.filter((p) => !isOpening(p))
  let protectedShelter = null, protectedHistoryLength = -1
  let shelterConstruction = new Set()
  function constructionBlock(position) {
    if (protectedShelter !== state.shelter ||
        protectedHistoryLength !== (state.shelterHistory ?? []).length) {
      protectedShelter = state.shelter
      protectedHistoryLength = (state.shelterHistory ?? []).length
      shelterConstruction = new Set(
        [state.shelter, ...(state.shelterHistory ?? []).map((s) => s.site)]
          .filter(Boolean)
          .flatMap((site) => shelterBlueprint(new Vec3(site.x, site.y, site.z)))
          .map((p) => p.toString()),
      )
    }
    if (layout && position.y === layout.flag.y) {
      const x = position.x - layout.flag.x, z = position.z - layout.flag.z
      if (Math.abs(x) <= WALL_RADIUS && Math.abs(z) <= WALL_RADIUS ||
          z > WALL_RADIUS && z <= WALL_RADIUS + 6 && Math.abs(x) <= 2) return true
    }
    const key = position.toString()
    return villageConstruction.has(key) || shelterConstruction.has(key)
  }
  function resetMovements() {
    skillRevision++
    blockedRoutes = 0
    escapeSession = null
    const moves = new Movements(bot)
    movements = moves
    moves.canDig = true
    moves.digCost = 2 // Prefer going around; clear ordinary terrain when needed.
    moves.exclusionAreasBreak.push((block) => {
      // Leaves can grow into a planned wall/home cell without becoming player
      // construction. Let navigation clear that natural obstruction.
      if ((constructionBlock(block.position) && !block.name.endsWith('_leaves')) ||
          resourceBusy(block.position)) return 100
      const soft =
        [
          'dirt',
          'grass_block',
          'sand',
          'gravel',
          'clay',
          'short_grass',
          'tall_grass',
          'snow',
        ].includes(block.name) ||
        block.name.endsWith('_leaves') ||
        isLog(block.name)
      const rock =
        ['stone', 'andesite', 'diorite', 'granite', 'coal_ore'].includes(
          block.name,
        ) && bot.inventory.items().some((i) => isPick(i.name))
      return soft || rock ? 0 : 100 // Preserve workbenches, furnaces and built shelters.
    })
    if (layout) {
      const plots = new Set(layout.farm.map((p) => p.toString()))
      moves.exclusionAreasStep.push((block) =>
        block?.name === 'farmland' && plots.has(block.position.toString()) ? 100 : 0)
      // Ordinary work routes must not descend into the porous village floor.
      // The dedicated escape skill temporarily lifts this boundary so an
      // already buried clanker can traverse its inspected way back out.
      moves.exclusionAreasStep.push((block) => {
        if (escaping || !block?.position) return 0
        const p = block.position
        const dx = p.x - layout.flag.x, dz = p.z - layout.flag.z
        const withinVillage = Math.abs(dx) <= WALL_RADIUS && Math.abs(dz) <= WALL_RADIUS ||
          dz > WALL_RADIUS && dz <= WALL_RADIUS + 6 && Math.abs(dx) <= 2
        return withinVillage && p.y <= layout.flag.y ? 100 : 0
      })
    }
    moves.allow1by1towers = false
    moves.allowParkour = false
    // A two-block drop into a blast hole can strand a clanker under the
    // village floor; keep village routes to steps they can climb back out of.
    moves.maxDropDown = villageCtx ? 1 : 2
    moves.allowSprinting = false
    moves.scafoldingBlocks = []
    bot.pathfinder.setMovements(moves)
    bot.pathfinder.thinkTimeout = 2500
    bot.pathfinder.tickTimeout = 20
  }
  bot.on('spawn', resetMovements)
  // Basic swimming belongs in the motor loop, not a multi-second model request.
  let swimming = false
  bot.on('physicsTick', () => {
    if (bot.entity?.isInWater) {
      bot.setControlState('jump', true)
      swimming = true
    } else if (swimming) {
      bot.setControlState('jump', false)
      swimming = false
    }
  })
  function threats() {
    return Object.values(bot.entities)
      .filter(
        (e) =>
          hostiles.has(e.name) &&
          e.position.distanceTo(bot.entity.position) < 12,
      )
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )
  }
  // Guest creeper players near the Server. The controller decides which
  // usernames count as guests; the bot only ever sees entities it can
  // already perceive.
  function enemyPlayers() {
    if (!villageCtx?.isEnemyPlayer) return []
    return Object.values(bot.entities).filter(
      (e) =>
        e.username &&
        villageCtx.isEnemyPlayer(e.username) &&
        e.position.distanceTo(villageCtx.flag) < 20,
    )
  }
  function emergency() {
    if (!bot.entity || bot.health <= 0) return null
    // A guard buried below stone cannot fight a spider overhead. Do not let
    // that unreachable target starve escape; contact/recent damage still wins.
    const danger = (entity) => Date.now() - lastHurtAt < 2500 ||
      entity.position.distanceTo(bot.entity.position) < 2 || sightToThreat(bot, entity)
    const visibleThreats = threats().filter(danger)
    const closeThreats = visibleThreats.filter(
      (e) => e.position.distanceTo(bot.entity.position) < 9,
    )
    if (villageCtx) {
      // Guards stand and fight; everyone else keeps the old flee reflex.
      if ((state.role ?? null) === 'guard' && bot.health > 8) {
        const flagThreats = visibleThreats.filter(
          (e) => e.position.distanceTo(villageCtx.flag) < 12,
        )
        if (closeThreats.length || flagThreats.length || enemyPlayers().filter(danger).length)
          return 'attack_threat'
      }
    }
    if (closeThreats.length) return 'flee'
    if (bot.food < 16 && bot.inventory.items().some((i) => edible.has(i.name)))
      return 'eat'
    return null
  }
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) lastHurtAt = Date.now()
    if (entity === bot.entity && escaping) {
      skillRevision++
      bot.pathfinder.setGoal(null)
      bot.stopDigging()
      return
    }
    if (entity === bot.entity && emergency() === 'flee' && !fleeing) {
      bot.pathfinder.setGoal(null)
      bot.stopDigging()
    }
  })
  const nearbyCache = new Map()
  let vegetationCache = null
  function vegetationTargets(fresh = false) {
    if (!villageCtx) return []
    if (fresh || !vegetationCache || Date.now() - vegetationCache.at > 3000 ||
        bot.entity.position.distanceTo(vegetationCache.origin) > 2) {
      const result = inspectVegetation(bot, villageCtx.flag, {
        known: state.naturalTreeLogs ?? [], protectedBlock: constructionBlock,
      })
      state.naturalTreeLogs = result.known
      vegetationCache = { ...result, at: Date.now(), origin: bot.entity.position.clone() }
    }
    return vegetationCache.targets.map((b) => bot.blockAt(b.position))
      .filter((b) => b && (naturalLeaf(b) || state.naturalTreeLogs.some((p) =>
        p.x === b.position.x && p.y === b.position.y && p.z === b.position.z && p.name === b.name)) &&
        !resourceBusy(b.position) && (blocked.get(b.position.toString()) ?? 0) < Date.now())
      .sort((a, b) => Number(bot.canDigBlock(b)) - Number(bot.canDigBlock(a)) ||
        Number(naturalLeaf(a)) - Number(naturalLeaf(b)) ||
        a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  }
  function vegetationTarget() {
    return vegetationTargets().find((b) => bot.canDigBlock(b) ||
      (b.position.y >= bot.entity.position.y - 1 && b.position.y <= bot.entity.position.y + 4))
  }
  function saplingSite() {
    return openGround(bot.entity.position, 7).find((p) => safeSaplingSite(p, villageCtx?.flag) &&
      ['grass_block', 'dirt'].includes(bot.blockAt(p.offset(0, -1, 0))?.name))
  }
  function nearbyBlock(matching, radius = 18, cacheKey = null, ttl = 5000, maxMove = 8) {
    // Empty scans are costly in a treeless biome. Reuse them briefly while
    // the clanker remains in the same area; recheck found blocks against the
    // live world so harvested or reserved resources never stay feasible.
    const now = Date.now()
    const cached = cacheKey && nearbyCache.get(cacheKey)
    if (cached && now - cached.at < ttl &&
        bot.entity.position.distanceTo(cached.origin) < maxMove) {
      if (!cached.position) return null
      const block = bot.blockAt(cached.position)
      if (block && matching(block) && usable(block)) return block
    }
    const found = bot
      .findBlocks({ matching, maxDistance: radius, count: 36 })
      .map((p) => bot.blockAt(p))
      .filter(usable)
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )[0]
    if (cacheKey) nearbyCache.set(cacheKey, {
      at: now, origin: bot.entity.position.clone(), position: found?.position.clone() ?? null,
    })
    return found
  }
  function usable(b) {
    return b &&
      !(isLog(b.name) && failedTrees.some((tree) =>
        tree.until > Date.now() &&
        Math.hypot(b.position.x - tree.x, b.position.z - tree.z) < 3)) &&
      !((isLog(b.name) || stoneNames.has(b.name) || ironOreNames.has(b.name)) &&
        (constructionBlock(b.position) || resourceBusy(b.position))) &&
      (blocked.get(b.position.toString()) ?? 0) < Date.now() &&
      b.position.y >= bot.entity.position.y - 3 &&
      b.position.y <= bot.entity.position.y + 5
  }
  async function bounded(work, ms, cancel = () => {}) {
    let timer
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            cancel()
            reject(new Error(`Action deadline ${ms}ms`))
          }, ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function walkOnce(goal, ms) {
    let checkpoint = bot.entity.position.clone(),
      progressed = Date.now()
    const watchdog = setInterval(() => {
      if (
        bot.entity.position.distanceTo(checkpoint) > 0.7 ||
        bot.targetDigBlock
      ) {
        checkpoint = bot.entity.position.clone()
        progressed = Date.now()
      } else if (Date.now() - progressed > 4000) {
        log('navigation_stuck', { position: bot.entity.position, goal: navigationGoalSummary(goal) })
        bot.pathfinder.setGoal(null)
      }
    }, 500)
    try {
      await bounded(
        () => gotoConfirmed(bot, goal),
        ms,
        () => bot.pathfinder.setGoal(null),
      )
    } finally {
      clearInterval(watchdog)
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
    }
  }
  const walk = async (goal, ms = 11000) => {
    const feet = bot.entity.position.floored()
    const standingOnLeaves = bot.blockAt(feet.offset(0, -1, 0))?.name.endsWith('_leaves')
    const normalDrop = movements?.maxDropDown
    // A clanker on a high canopy needs a short downward step to reach lower
    // leaves. Keep the stricter limit for ordinary village routes and pits.
    if (villageCtx && standingOnLeaves &&
        bot.entity.position.y >= villageCtx.flag.y + 5 && movements)
      movements.maxDropDown = 2
    try {
      const result = await navigateWithRecovery({ bot, goal, ms, run: walkOnce, emergency, log })
      blockedRoutes = 0
      return result
    } catch (error) {
      blockedRoutes++
      lastBlockedRoute = Date.now()
      throw error
    } finally {
      if (movements && normalDrop != null) movements.maxDropDown = normalDrop
    }
  }
  async function descendFromPerch() {
    const landing = villageCtx &&
      (safePerchLanding(bot, villageCtx.flag.y) || safeLedgeLanding(bot, villageCtx.flag.y))
    if (!landing) throw new Error('No inspected safe descent from the current perch')
    const before = bot.entity.position.clone()
    const target = new Vec3(landing.x + 0.5, before.y + 1.62, landing.z + 0.5)
    await bot.lookAt(target)
    try {
      bot.setControlState('forward', true)
      const edgeDeadline = Date.now() + 1800
      while (Date.now() < edgeDeadline && bot.health > 0) {
        await sleep(50)
        const feet = bot.entity.position.floored()
        if ((feet.x === landing.x && feet.z === landing.z) ||
            bot.entity.position.y < before.y - 0.2) break
      }
    } finally {
      bot.setControlState('forward', false)
    }
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && bot.health > 0 &&
           bot.entity.position.y > landing.y + 0.1) await sleep(50)
    const feet = bot.entity.position.floored()
    if (feet.x !== landing.x || feet.z !== landing.z ||
        Math.abs(bot.entity.position.y - landing.y) > 0.12)
      throw new Error('Inspected descent did not reach its landing')
    log('perch_descent', { from: before, position: bot.entity.position, drop: landing.drop })
    return { descended: true, drop: landing.drop, position: bot.entity.position.clone() }
  }
  async function clearRootedTreeExit() {
    const at = rootedTreeExit(bot)
    if (!at) throw new Error('No inspected rooted tree blocks the local exit')
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    let cleared = 0
    for (const dy of [1, 0]) {
      if (!rootedTreeExit(bot)?.equals(at)) {
        // After the upper log is cleared, its crown proof still holds until
        // the lower log is removed. Recheck the actual block before digging.
        if (dy === 1) throw new Error('Tree exit changed before clearing')
      }
      const block = bot.blockAt(at.offset(0, dy, 0))
      if (!isLog(block?.name ?? '') || !bot.canDigBlock(block))
        throw new Error('Tree exit is no longer reachable')
      await bounded(() => bot.dig(block, true), escapeDigBudget(bot.digTime(block)),
        () => bot.stopDigging())
      if (isLog(bot.blockAt(block.position)?.name ?? ''))
        throw new Error('Tree exit clearing was not confirmed')
      cleared++
    }
    log('tree_exit_cleared', { position: at, cleared })
    return { cleared, position: at }
  }
  function escapeTarget() {
    const target = escapeSession ?? (villageCtx ? villageCtx.flag.offset(0, 1, 0) : state.camp)
    if (!target || bot.entity.isInWater) return null
    const feet = bot.entity.position.floored()
    const roofed = () => {
      for (let y = feet.y + 2; y <= Math.max(feet.y + 3, target.y + 2); y++) {
        const block = bot.blockAt(new Vec3(feet.x, y, feet.z))
        if (block && solid(block) && !block.name.endsWith('_leaves')) return true
      }
      return false
    }
    // A lower outdoor bank is not an underground trap. Repeated route failures
    // there should not latch an endless attempt to climb to monument altitude.
    if (escapeSession && villageCtx && bot.entity.onGround) {
      if (solid(bot.blockAt(feet.offset(0, -1, 0))) && !roofed()) {
        escapeSession = null; blockedRoutes = 0; return null
      }
    }
    if (bot.entity.position.y >= target.y - 0.1 ||
        Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) > 32) {
      escapeSession = null
      return null
    }
    if (!escapeSession && (blockedRoutes < 2 || Date.now() - lastBlockedRoute > 60000 ||
        target.y - bot.entity.position.y < 3)) return null
    if (villageCtx && !roofed()) return null
    escapeSession ??= new Vec3(target.x, target.y, target.z)
    return escapeSession
  }
  async function escapeUpward() {
    escaping = true
    try { return await escapeUpwardStep() }
    finally { escaping = false }
  }
  async function escapeUpwardStep(destination = null) {
    const revision = skillRevision
    const interrupted = () => revision !== skillRevision || bot.health <= 0 || emergency()
    const target = escapeTarget()
    if (!target) throw new Error('No blocked underground route to recover')
    const protectedBlock = (position) => {
      if (resourceBusy(position)) return true
      const block = bot.blockAt(position)
      // Natural ground over a trapped clanker is an escape hatch, even when
      // the village floor is otherwise protected from routine path digging.
      // Never clear a placed wall/home block or a fixture to make that hatch.
      if (villageCtx && position.y === layout.flag.y &&
          ['dirt', 'grass_block'].includes(block?.name) &&
          !villageConstruction.has(position.toString())) return false
      return constructionBlock(position)
    }
    const plans = localEscapePlans(bot, target, protectedBlock)
    const plan = destination ? plans.find((p) => p.destination.equals(destination)) : plans[0]
    if (destination && !plan) throw new Error('Selected escape step is no longer safe')
    if (!plan) {
      const next = localEscapeReposition(bot, target, protectedBlock)
      if (next) {
        const before = bot.entity.position.clone()
        await walk(new goals.GoalBlock(next.x, next.y, next.z), 5000)
        if (interrupted()) throw new Error('Escape reposition interrupted')
        if (Math.hypot(bot.entity.position.x - next.x - 0.5,
          bot.entity.position.z - next.z - 0.5) > 0.8)
          throw new Error('Escape reposition did not reach the safe square')
        log('escape_reposition', { from: before, position: bot.entity.position })
        return { repositioned: true, position: bot.entity.position.clone() }
      }
      log('escape_blocked', { position: bot.entity.position, target, reason: 'No inspected safe staircase step' })
      await sleep(1500)
      throw new Error('No safe local staircase step; holding recovery position')
    }
    const before = bot.entity.position.clone()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    const pick = bot.inventory.items().find((i) => isPick(i.name))
    if (pick) await bot.equip(pick, 'hand')
    else if (bot.heldItem) await bot.unequip('hand')
    let cleared = 0
    for (const position of plan.clear) {
      if (interrupted()) throw new Error('Escape interrupted by safety or cancellation')
      // Re-check after every server update; hazards or another builder may have appeared.
      if (!localEscapePlans(bot, target, protectedBlock).some((p) => p.destination.equals(plan.destination)))
        throw new Error('Escape step is no longer safe')
      const block = bot.blockAt(position)
      if (!solid(block)) continue
      if (!bot.canDigBlock(block)) throw new Error('Escape block is out of reach')
      const digBudget = escapeDigBudget(bot.digTime(block))
      let confirmed = false
      const update = (packet) => {
        if (new Vec3(packet.location.x, packet.location.y, packet.location.z).equals(position) &&
            packet.type === bot.registry.blocksByName.air.minStateId) confirmed = true
      }
      bot._client.on('block_change', update)
      try {
        log('escape_clearing', { position, block: block.name, byHand: !pick, destination: plan.destination, digBudget })
        await bounded(() => bot.dig(block, true), digBudget, () => bot.stopDigging())
        const deadline = Date.now() + 1500
        while (!confirmed && Date.now() < deadline) await sleep(50)
        if (!confirmed) throw new Error('Escape clearing was not confirmed by the server')
        cleared++
      } finally {
        bot._client.removeListener('block_change', update)
      }
    }
    if (interrupted()) throw new Error('Escape interrupted before climbing')
    await walk(new goals.GoalBlock(plan.destination.x, plan.destination.y, plan.destination.z), 5000)
    await sleep(250)
    if (interrupted()) throw new Error('Escape interrupted before movement was confirmed')
    const rose = bot.entity.position.y - before.y
    if (rose < 0.75 || Math.hypot(bot.entity.position.x - plan.destination.x - 0.5,
      bot.entity.position.z - plan.destination.z - 0.5) > 0.8)
      throw new Error('Escape step did not reach the higher foothold')
    log('escape_progress', { from: before, position: bot.entity.position, cleared, rose })
    if (bot.entity.position.y >= target.y - 0.1) escapeSession = null
    return { escapedUpward: true, cleared, rose, position: bot.entity.position.clone() }
  }
  async function reach(block) {
    const inDigReach = () => bot.canDigBlock?.(bot.blockAt(block.position)) ?? false
    if (!inDigReach()) {
      // A standing clanker can chop a branch above its head. A goal at the
      // branch's Y level asks Pathfinder to climb an impossible trunk.
      const elevatedLog = isLog(block.name) &&
        block.position.y >= bot.entity.position.y + 2
      const goal = elevatedLog
        ? new goals.GoalNearXZ(block.position.x, block.position.z, 1)
        : new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z)
      // Surface resources usually have a clear route. Searching routes that
      // may dig every nearby block is expensive with a full village cast.
      const activeMoves = movements
      if (activeMoves) activeMoves.canDig = false
      try {
        await walkOnce(goal, 4000)
      } catch (error) {
        log('resource_clear_route_failed', { target: block.position, error: String(error) })
      } finally {
        if (activeMoves) activeMoves.canDig = true
      }
      if (!inDigReach()) await walk(goal)
    }
    if (!inDigReach())
      throw new Error('Block still out of reach')
  }
  async function approach(position, range, { minY = -Infinity, maxY = Infinity } = {}) {
    const target = new Vec3(position.x, position.y, position.z)
    const before = bot.entity.position.clone()
    if (before.distanceTo(target) <= range && before.y >= minY && before.y <= maxY)
      return { returned: true, remaining: 0, moved: 0 }
    const dx = target.x - before.x, dz = target.z - before.z
    const horizontal = Math.hypot(dx, dz)
    // Distant remembered coordinates are a direction, not a single enormous
    // A* search. Each action must make verified local progress toward them.
    const goal = horizontal > 14
      ? new goals.GoalNearXZ(before.x + dx / horizontal * 12, before.z + dz / horizontal * 12, 1)
      : new goals.GoalNear(target.x, target.y, target.z, before.y < minY ? 2 : range)
    await walk(goal, 9000)
    const remaining = bot.entity.position.distanceTo(target)
    const moved = before.distanceTo(bot.entity.position)
    const returned = remaining <= range && bot.entity.position.y >= minY &&
      bot.entity.position.y <= maxY
    if (!returned && moved < 0.75)
      throw new Error('Return route made no positional progress')
    return {
      returned,
      remaining: Math.round(remaining),
      moved: Math.round(moved * 10) / 10,
    }
  }
  async function collectItem(item, radius = 0) {
    // A branch drop may land on leaves above pickup reach. Clear only nearby
    // natural leaves directly supporting that item, then let it fall.
    for (let i = 0; i < 3 && item.position.y > bot.entity.position.y + 2; i++) {
      const support = bot.blockAt(item.position.floored().offset(0, -1, 0))
      if (!support?.name.endsWith('_leaves') || constructionBlock(support.position) ||
          !bot.canDigBlock(support)) break
      await bounded(() => bot.dig(support), 3000, () => bot.stopDigging())
      if (bot.blockAt(support.position)?.name === support.name)
        throw new Error('Leaf under the drop was not cleared')
      await sleep(400)
    }
    const elevated = item.position.y > bot.entity.position.y + 2
    await walk(
      elevated
        ? new goals.GoalNearXZ(item.position.x, item.position.z, Math.max(1, radius))
        : new goals.GoalNear(item.position.x, item.position.y, item.position.z, radius),
      7000,
    )
    await sleep(650)
  }
  async function collect(position) {
    await sleep(650) // item spawn, pickup delay, and falling logs need server ticks
    const item = Object.values(bot.entities)
      .filter((e) => e.name === 'item' && e.position.distanceTo(position) < 5 && !resourceBusy(e.position))
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )[0]
    if (item) await collectItem(item)
  }
  async function dig(block, toolSuffix) {
    const resource = isLog(block.name) || stoneNames.has(block.name) ||
      ironOreNames.has(block.name) || ['grass_block', 'dirt'].includes(block.name)
    const release = resource ? claimResource(block) : () => {}
    const before = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }))
    try {
      if (resource) log('resource_approach', { block: block.name, target: block.position,
        from: bot.entity.position, distance: Math.round(bot.entity.position.distanceTo(block.position)) })
      await reach(block)
      if (bot.blockAt(block.position)?.name !== block.name)
        throw new Error('Resource changed before gathering began')
      const items = bot.inventory.items()
      const tool = bestEquipment(items, toolSuffix ?? '_pickaxe')
      if (tool) await bot.equip(tool, 'hand')
      if (!bot.canDigBlock(block))
        throw new Error('Block cannot be dug from here')
      await bounded(
        () => bot.dig(block),
        12000,
        () => bot.stopDigging(),
      )
      let pickupError
      await collect(block.position).catch((error) => { pickupError = error })
      const gained = inventoryGains(before, bot.inventory.items())
      const expected = isLog(block.name) ? block.name
        : block.name === 'coal_ore' ? 'coal'
          : ironOreNames.has(block.name) ? 'raw_iron'
            : stoneNames.has(block.name) ? 'cobblestone'
              : ['grass_block', 'dirt'].includes(block.name) ? 'dirt' : null
      if (resource && !gained.some((item) => item.name === expected)) {
        log('gather_uncollected', { block: block.name, position: block.position, gained,
          error: pickupError ? String(pickupError) : 'No matching item reached inventory' })
        throw new Error(`Gathering ${block.name} did not deliver ${expected} to inventory`)
      }
      return { block: block.name, position: block.position, collected: gained }
    } catch (e) {
      blocked.set(block.position.toString(), Date.now() + 120000)
      if (isLog(block.name) && /path|deadline|GoalChanged|Navigation/i.test(String(e))) {
        failedTrees.push({ x: block.position.x, z: block.position.z, until: Date.now() + 30000 })
        while (failedTrees.length > 20) failedTrees.shift()
      }
      throw e
    } finally {
      release()
    }
  }
  // Crafting and village checks can ask for the same station several times in
  // one decision. The scan is expensive; nearbyBlock rechecks a cached hit
  // against the live world before returning it.
  const table = () => nearbyBlock((b) => b.name === 'crafting_table', 24, 'table24', 1500)
  async function craft(name, times = 1) {
    const item = bot.registry.itemsByName[name]
    if (!item) throw new Error(`Unknown item ${name}`)
    // Inventory recipes (planks, sticks, workbench) do not need a trip to a
    // distant or obstructed workbench merely because one is in loaded chunks.
    let bench = null
    let recipe = craftableRecipe(bot, item)
    if (!recipe) {
      bench = table()
      if (bench) {
        try {
          await reach(bench)
        } catch (error) {
          blocked.set(bench.position.toString(), Date.now() + 120000)
          throw error
        }
      }
      recipe = craftableRecipe(bot, item, bench)
    }
    if (!recipe) throw new Error(`Missing ingredients or workbench for ${name}`)
    const before = countItems(bot.inventory.items(), name)
    await craftConfirmed(bot, recipe, times, bench)
    const gained = countItems(bot.inventory.items(), name) - before
    if (gained < recipe.result.count * times)
      throw new Error(`Crafting incomplete: server confirmed ${gained} ${name}`)
    return { crafted: name, times }
  }
  async function place(position, item, { minOffset = 2 } = {}) {
    if (solid(bot.blockAt(position))) return { alreadyPresent: true }
    // Range is measured from the eyes to an exposed face. A nearby support
    // block can still be occluded or below reach on a hillside.
    const goal = new goals.GoalPlaceBlock(position, bot.world, {
      range: 4.25,
      LOS: true,
    })
    // Pathfinder evaluates block centres, but actual feet can stop a few cm
    // away. Reject routes that only see the face by grazing a block corner.
    const visible = (node, jumpHeight = 0) =>
      [
        [0.35, 0.35],
        [0.65, 0.35],
        [0.35, 0.65],
        [0.65, 0.65],
      ].every(([x, z]) =>
        goal.getFaceAndRef(
          node.offset(x, bot.entity.eyeHeight + jumpHeight, z),
        ),
      )
    goal.isEnd = (node) =>
      Math.max(Math.abs(node.x - position.x), Math.abs(node.z - position.z)) >=
        minOffset &&
      (visible(node) || visible(node, 1))
    if (!goal.isEnd(bot.entity.position.floored())) await walk(goal, 15000)
    await sleep(200) // Let the last movement tick settle before placing.
    const available = bot.inventory.items().find((held) => held.name === item?.name && held.count > 0)
    if (!available) throw new Error(`Placement material ${item?.name ?? 'unknown'} is no longer in inventory`)
    await bot.equip(available, 'hand')
    if (bot.heldItem?.name !== available.name) {
      await sleep(100)
      const retry = bot.inventory.items().find((held) => held.name === available.name && held.count > 0)
      if (retry) await bot.equip(retry, 'hand')
    }
    if (bot.heldItem?.name !== available.name)
      throw new Error(`Could not equip ${available.name} for placement`)
    let hit = goal.getFaceAndRef(
      bot.entity.position.offset(0, bot.entity.eyeHeight, 0),
    )
    if (!hit && bot.entity.onGround) {
      bot.setControlState('jump', true)
      const deadline = Date.now() + 1000
      while (!hit && Date.now() < deadline) {
        await sleep(25)
        hit = goal.getFaceAndRef(
          bot.entity.position.offset(0, bot.entity.eyeHeight, 0),
        )
      }
    }
    if (!hit) {
      bot.setControlState('jump', false)
      throw new Error('No exposed placement face within reach')
    }
    const face = hit.face.scaled(-1)
    const reference = bot.blockAt(hit.ref)
    const crouch = ['crafting_table', 'furnace', 'chest'].includes(reference.name) ||
      reference.name.endsWith('_bed')
    bot.setControlState('sneak', crouch)
    try {
      await bounded(
        () =>
          bot._placeBlockWithOptions(reference, face, {
            forceLook: true,
            swingArm: 'right',
          }),
        7000,
      )
    } catch (error) {
      log('placement_rejected', {
        position: bot.entity.position,
        target: position,
        reference: reference.position,
        face,
        held: bot.heldItem?.name,
      })
      throw error
    } finally {
      bot.setControlState('sneak', false)
      bot.setControlState('jump', false)
    }
    if (bot.blockAt(position)?.name !== item.name)
      throw new Error(`Placement was not confirmed at ${position}`)
    return { placed: item.name, position }
  }
  // ---- village construction and coolant skills ----------------------------
  function constructionMaterials(hasWorkbench = Boolean(table()), allowDirt = false) {
    const items = bot.inventory.items()
    const planks = countItems(items, isPlank)
    const reserved = woodForTools(items, hasWorkbench)
    const usablePlanks = Math.max(0, planks - reserved)
    const usableLogs = Math.min(
      countItems(items, (name) => isLog(name) && isBuildMaterial(name)),
      Math.max(0, countItems(items, isLog) - Math.ceil(Math.max(0, reserved - planks) / 4)),
    )
    const mineral = items.filter((item) => isBuildMaterial(item.name) && !isPlank(item.name) && !isLog(item.name))
    const planksItem = usablePlanks > 0 ? items.find((item) => isPlank(item.name)) : null
    const logItem = usableLogs > 0 ? items.find((item) => isLog(item.name) && isBuildMaterial(item.name)) : null
    const dirt = allowDirt ? items.find((item) => item.name === 'dirt') : null
    return {
      count: countItems(mineral, () => true) + usablePlanks + (logItem ? usableLogs : 0) + (dirt?.count ?? 0),
      first: mineral[0] ?? planksItem ?? logItem ?? dirt,
    }
  }
  const buildMaterialCount = (hasWorkbench) => constructionMaterials(hasWorkbench).count
  const firstBuildMaterial = (allowDirt = false) => constructionMaterials(undefined, allowDirt).first
  /** Place up to `perAction` missing blueprint blocks; the wall starts nearby. */
  async function buildFrom(blueprint, perAction = 2, { allowDirt = false, nearest = false } = {}) {
    let placed = 0
    let lastError, failed = 0
    const positions = nearest ? blueprint.slice().sort((a, b) =>
      a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)) : blueprint
    for (const p of positions) {
      if (isOpening(p)) continue
      if (structuralBlock(bot.blockAt(p))) continue
      const occupant = bot.blockAt(p)
      if (['short_grass', 'tall_grass'].includes(occupant?.name) || occupant?.name.endsWith('_leaves'))
        await dig(occupant, '_axe')
      else if (solid(occupant))
        throw new Error(`Unsuitable ${occupant.name} occupies construction at ${p}; preserve it for replanning`)
      const material = firstBuildMaterial(allowDirt)
      if (!material) break
      try {
        const result = await place(p, material, { minOffset: nearest ? 1 : 2 })
        if (result.placed && ++placed === perAction) break
      } catch (error) {
        if (!nearest) throw error
        lastError = error
        if (++failed >= 3) break
      }
    }
    if (!placed && lastError) throw lastError
    return { placed }
  }
  const farmStage = (p) => {
    const ground = bot.blockAt(p), crop = bot.blockAt(p.offset(0, 1, 0))
    return { ground, crop, mature: crop?.name === 'wheat' && Number(crop.getProperties()?.age) >= 7 }
  }
  const holeTargets = () => blastHoleTargets(layout.flag, (p) => bot.blockAt(p))
  const repairOptions = () => holeTargets().filter((target) =>
    target.y >= layout.flag.y - 1 &&
    !resourceBusy(target) &&
    (blocked.get(target.toString()) ?? 0) < Date.now()).flatMap((target) => {
    const stations = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => layout.flag.offset(target.x - layout.flag.x + dx, 0,
        target.z - layout.flag.z + dz))
      .filter((ground) => {
        const floor = bot.blockAt(ground)
        return solid(floor) && floor.name !== 'farmland' &&
          bot.blockAt(ground.offset(0, 1, 0))?.name === 'air' &&
          bot.blockAt(ground.offset(0, 2, 0))?.name === 'air'
      })
    return stations.map((ground) => ({ target, stand: ground.offset(0, 1, 0) }))
  })
  async function awaitBlock(position, expected) {
    const deadline = Date.now() + 1800
    while (Date.now() < deadline) {
      const block = bot.blockAt(position)
      if (expected(block)) return block
      await sleep(75)
    }
    throw new Error(`Server did not confirm block update at ${position}`)
  }
  async function useToolOnGround(position, toolSuffix, expectedName) {
    const block = bot.blockAt(position)
    if (!block) throw new Error('Ground is not loaded')
    const tool = bot.inventory.items().find((i) => i.name.endsWith(toolSuffix))
    if (!tool) throw new Error(`No ${toolSuffix.slice(1)} in inventory`)
    await reach(block)
    await bot.equip(tool, 'hand')
    await bot.activateBlock(bot.blockAt(position))
    await awaitBlock(position, (b) => b?.name === expectedName)
    return { changed: expectedName, position }
  }
  async function repairBlastHole() {
    const option = repairOptions().sort((a, b) =>
      a.stand.distanceTo(bot.entity.position) - b.stand.distanceTo(bot.entity.position))[0]
    if (!option) throw new Error('No reachable blast hole on the village floor')
    const { target, stand } = option
    const item = bot.inventory.items().find((i) => ['dirt', 'cobblestone', 'stone'].includes(i.name))
    if (!item) throw new Error('No dirt or stone to fill the hole')
    const release = claimResource({ name: 'air', position: target })
    try {
      try {
        await walk(new goals.GoalBlock(stand.x, stand.y, stand.z), 9000)
      } catch (error) {
        blocked.set(target.toString(), Date.now() + 120000)
        throw error
      }
      const references = [target.offset(0, -1, 0),
        target.offset(1, 0, 0), target.offset(-1, 0, 0),
        target.offset(0, 0, 1), target.offset(0, 0, -1)]
      const support = references.map((p) => bot.blockAt(p)).find((block) =>
        solid(block) && !['sand', 'red_sand', 'gravel'].includes(block.name))
      if (!support || bot.blockAt(target)?.name !== 'air')
        throw new Error('Blast-hole support changed before repair')
      if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.4)
        throw new Error('Blast hole is out of placement reach')
      const available = bot.inventory.items().find((i) => i.name === item.name && i.count > 0)
      if (!available) throw new Error('Repair material left inventory')
      await bot.equip(available, 'hand')
      if (bot.heldItem?.name !== available.name) throw new Error('Repair material is not held')
      await bounded(() => bot._placeBlockWithOptions(support, target.minus(support.position),
        { forceLook: true, swingArm: 'right' }), 7000)
      await awaitBlock(target, (b) => b?.name === available.name)
      return { placed: available.name, position: target, repairedHole: true }
    } finally {
      release()
    }
  }
  async function tendFarm() {
    const plot = layout.farm.find((p) => {
      const { ground, crop } = farmStage(p)
      return ['grass_block', 'dirt'].includes(ground?.name) &&
        ['air', 'short_grass', 'tall_grass'].includes(crop?.name)
    })
    if (!plot) throw new Error('No untilled clear plot in the planned farm')
    await reach(bot.blockAt(plot))
    const grass = bot.blockAt(plot.offset(0, 1, 0))
    if (grass?.name !== 'air') await dig(grass)
    if (bot.blockAt(plot.offset(0, 1, 0))?.name !== 'air')
      throw new Error('Farm plot still has an obstruction')
    return { ...await useToolOnGround(plot, '_hoe', 'farmland'), farm: true }
  }
  async function sowWheat() {
    const plot = layout.farm.find((p) => {
      const { ground, crop } = farmStage(p)
      return ground?.name === 'farmland' && crop?.name === 'air'
    })
    const seeds = bot.inventory.items().find((i) => i.name === 'wheat_seeds')
    if (!plot || !seeds) throw new Error('No clear farmland or wheat seeds')
    await reach(bot.blockAt(plot))
    await bot.equip(seeds, 'hand')
    await bot.activateBlock(bot.blockAt(plot))
    await awaitBlock(plot.offset(0, 1, 0), (b) => b?.name === 'wheat')
    return { planted: 'wheat', position: plot }
  }
  async function harvestWheat() {
    const plot = layout.farm.find((p) => farmStage(p).mature)
    if (!plot) throw new Error('No mature wheat in the farm')
    const crop = bot.blockAt(plot.offset(0, 1, 0))
    const result = await dig(crop)
    if (bot.blockAt(crop.position)?.name === 'wheat')
      throw new Error('Wheat harvest was not confirmed')
    return { harvested: 'wheat', position: crop.position, collected: result.collected }
  }
  async function paveRoad() {
    const spot = layout.roads.find((p) =>
      ['grass_block', 'dirt'].includes(bot.blockAt(p)?.name) &&
      ['air', 'short_grass', 'tall_grass'].includes(bot.blockAt(p.offset(0, 1, 0))?.name))
    if (!spot) throw new Error('No unpaved clear lane in the village plan')
    await reach(bot.blockAt(spot))
    const grass = bot.blockAt(spot.offset(0, 1, 0))
    if (grass?.name !== 'air') await dig(grass)
    if (bot.blockAt(spot.offset(0, 1, 0))?.name !== 'air')
      throw new Error('Road spot still has an obstruction')
    return { ...await useToolOnGround(spot, '_shovel', 'dirt_path'), road: true }
  }
  const oreNearby = () => nearbyBlock((b) => ironOreNames.has(b.name), 16, 'ore16', 1500)
  const wallEarthNearby = () => bot.findBlocks({
    matching: (b) => ['grass_block', 'dirt'].includes(b.name) &&
      !constructionBlock(b.position) &&
      Math.hypot(b.position.x + 0.5 - bot.entity.position.x,
        b.position.z + 0.5 - bot.entity.position.z) >= 2,
    maxDistance: 22,
    count: 12,
    useExtraInfo: true,
  }).map((p) => bot.blockAt(p)).filter(usable)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) -
      b.position.distanceTo(bot.entity.position))[0]
  const furnaceNearby = () => nearbyBlock((b) => b.name === 'furnace', 16, 'furnace16', 1500)
  async function smeltIron() {
    const run = async () => {
      const furnaceBlock = furnaceNearby()
      if (!furnaceBlock) throw new Error('No furnace nearby')
      // Re-find everything inside the serialized section: another clanker's
      // smelt may have run while this one waited for the chain.
      const raw = bot.inventory.items().find((i) => i.name === 'raw_iron')
      if (!raw) throw new Error('No raw iron to smelt')
      const fuel =
        bot.inventory.items().find((i) => i.name === 'coal') ??
        bot.inventory.items().find((i) => isPlank(i.name)) ??
        bot.inventory.items().find((i) => isLog(i.name))
      if (!fuel) throw new Error('No fuel (coal or planks) for the furnace')
      await reach(furnaceBlock)
      // bot.openFurnace can hang if the window never opens (destroyed block,
      // server hiccup) — bound it like every other action.
      const furnace = await bounded(() => bot.openFurnace(furnaceBlock), 10000)
    try {
      // One coal smelts 8 items; a plank or log smelts 1.5. Never batch more
      // than the fuel on hand can finish.
      const fuelYield = fuel.name === 'coal' ? 8 * fuel.count : Math.floor(1.5 * fuel.count)
      const count = Math.min(raw.count, fuel.name === 'coal' ? 4 : 2, fuelYield)
      const fuelCount = fuel.name === 'coal' ? Math.ceil(count / 8) : Math.ceil(count / 1.5)
      await furnace.putFuel(
        bot.registry.itemsByName[fuel.name].id,
        null,
        fuelCount,
      )
      await furnace.putInput(bot.registry.itemsByName.raw_iron.id, null, count)
      const perItemMs = 11000
      const deadline = Date.now() + count * perItemMs + 9000
      while (Date.now() < deadline) {
        const out = furnace.outputItem()
        if (out?.name === 'iron_ingot' && out.count >= count) break
        await sleep(500)
      }
      const out = furnace.outputItem()
      if (out?.name !== 'iron_ingot' || out.count < count)
        throw new Error(`Furnace produced ${out?.count ?? 0}/${count} ingots`)
      await furnace.takeOutput()
    } catch (error) {
      // Best effort: pull the ore, fuel and any partial output back out so
      // nothing is stranded inside the furnace when the chain fails.
      await furnace.takeOutput().catch(() => {})
      await furnace.takeInput().catch(() => {})
      await furnace.takeFuel().catch(() => {})
      throw error
    } finally {
      await furnace.close().catch(() => {})
    }
      const gained = countItems(bot.inventory.items(), 'iron_ingot')
      if (gained < 1) throw new Error('Smelting did not yield iron ingots')
      return { smelted: gained }
    }
    const runNow = furnaceChain.then(run, run)
    furnaceChain = runNow.then(
      () => {},
      () => {},
    )
    return runNow
  }
  /** Fill an empty bucket at a known water source (the coolant spring). */
  async function scoopWater() {
    if (remoteSpring && bot.entity.position.distanceTo(remoteSpring) > 5)
      throw new Error('Travel to the remote coolant spring before scooping')
    const water = (remoteSpring ? coolantCells(remoteSpring) : layout.anatomy.spring)
      .map((p) => bot.blockAt(p))
      .filter((b) => b?.name === 'water')
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )[0]
    if (!water) throw new Error('The coolant spring is dry')
    await walk(
      new goals.GoalNear(water.position.x, water.position.y, water.position.z, 2),
    )
    const floor = bot.blockAt(water.position.offset(0, -1, 0))
    if (!solid(floor)) throw new Error('Spring has no solid bed')
    const bucket = bot.inventory.items().find((i) => i.name === 'bucket')
    if (!bucket) throw new Error('No empty bucket')
    const fullBefore = countItems(bot.inventory.items(), 'water_bucket')
    const emptyBefore = countItems(bot.inventory.items(), 'bucket')
    await bot.equip(bucket, 'hand')
    if (remoteSpring && bot.heldItem.count > 1) {
      // A stack of empty buckets sends its filled result to another slot.
      // Hold one so the server rule can tag precisely the newly filled item.
      if (bot.inventory.firstEmptySlotRange(9, 45) === null)
        throw new Error('Need one free inventory slot to carry expedition coolant')
      await bot.unequip('hand')
      const slot = bot.quickBarSlot + 36
      const stack = bot.inventory.items().find((i) => i.name === 'bucket' && i.slot !== slot)
      if (!stack || bot.inventory.slots[slot]) throw new Error('No free hand slot to split an empty bucket')
      await bot.transfer({ itemType: bot.registry.itemsByName.bucket.id, count: 1,
        sourceStart: stack.slot, sourceEnd: stack.slot + 1, destStart: slot, destEnd: slot + 1 })
      await sleep(150)
    }
    if (remoteSpring && (bot.heldItem?.name !== 'bucket' || bot.heldItem.count !== 1))
      throw new Error('Could not prepare one empty bucket for coolant')
    // Buckets use the held-item packet, not block placement. An infinite
    // spring can refill within the same tick, so inventory is the proof.
    await bot.lookAt(water.position.offset(0.5, 0.8, 0.5), true)
    bot.activateItem()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (countItems(bot.inventory.items(), 'water_bucket') > fullBefore &&
          countItems(bot.inventory.items(), 'bucket') < emptyBefore &&
          (!remoteSpring || isCoolantBucket(bot.heldItem)))
        return { filledBucket: true }
      await sleep(50)
    }
    throw new Error('Bucket did not fill at the spring')
  }
  /**
   * Feed the Server one bucket through its cauldron deposit. Both the filled
   * cauldron and the emptied bucket must be confirmed by the server. The
   * match controller empties the deposit later so the next feed can start.
   */
  async function feedServer({ disposeOrdinary = false } = {}) {
    const cycle = async () => {
      const { deposit } = layout.anatomy
      await walk(new goals.GoalLookAtBlock(deposit, bot.world, { reach: 4.25 }))
      const block = bot.blockAt(deposit)
      if (block?.name === 'water_cauldron')
        throw new Error('The Server is still drinking the last bucket')
      if (block?.name !== 'cauldron') throw new Error('Server coolant deposit is missing')
      const full = bot.inventory.items().find((item) => disposeOrdinary
        ? item.name === 'water_bucket' && !coolantItem(item) : coolantItem(item))
      if (!full) throw new Error(disposeOrdinary ? 'No ordinary water to empty' : 'No eligible coolant bucket to feed the Server')
      const fullBefore = countItems(bot.inventory.items(), 'water_bucket')
      const emptyBefore = countItems(bot.inventory.items(), 'bucket')
      await bot.equip(full, 'hand')
      await bot.activateBlock(block)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (bot.blockAt(deposit)?.name === 'water_cauldron' &&
            countItems(bot.inventory.items(), 'water_bucket') < fullBefore &&
            countItems(bot.inventory.items(), 'bucket') > emptyBefore)
          return disposeOrdinary ? { disposedOrdinaryWater: true } : { fedCoolant: true }
        await sleep(50)
      }
      throw new Error('Server deposit was not confirmed filled with an emptied bucket')
    }
    if (villageCtx?.withBasin) return villageCtx.withBasin(cycle)
    return cycle()
  }
  async function patrolOnce() {
    state.patrolIndex =
      ((state.patrolIndex ?? 0) + 1) % Math.max(1, layout.patrol.length)
    const node = layout.patrol[state.patrolIndex]
    await walk(new goals.GoalNear(node.x, node.y, node.z, 2))
    return { patrolled: node }
  }
  async function attackThreat() {
    const targets = [
      ...enemyPlayers(),
      ...Object.values(bot.entities).filter(
        (e) =>
          hostiles.has(e.name) &&
          (e.position.distanceTo(bot.entity.position) < 2 || sightToThreat(bot, e)) &&
          (e.position.distanceTo(bot.entity.position) < 12 ||
            e.position.distanceTo(villageCtx.flag) < 12),
      ),
    ].sort(
      (a, b) =>
        a.position.distanceTo(bot.entity.position) -
        b.position.distanceTo(bot.entity.position),
    )
    const target = targets[0]
    if (!target) return { peaceful: true }
    const weapon =
      bestEquipment(bot.inventory.items(), '_sword') ??
      bestEquipment(bot.inventory.items(), '_axe')
    if (weapon) await bot.equip(weapon, 'hand')
    const deadline = Date.now() + 20000
    while (
      bot.entities[target.id] &&
      Date.now() < deadline &&
      bot.health > 6 &&
      target.position.distanceTo(villageCtx.flag) < 24
    ) {
      if (target.position.distanceTo(bot.entity.position) > 2.6)
        await walk(new goals.GoalFollow(target, 2), 6000)
      await bot.lookAt(target.position.offset(0, 0.8, 0))
      bot.attack(target)
      await sleep(800)
    }
    return {
      engaged: target.username ?? target.name,
      defeated: !bot.entities[target.id],
      health: Math.round(bot.health),
    }
  }

  function openGround(center, radius = 5) {
    const candidates = []
    for (let dx = -radius; dx <= radius; dx++)
      for (let dz = -radius; dz <= radius; dz++)
        for (let dy = -2; dy <= 2; dy++) {
          const p = new Vec3(
            Math.floor(center.x) + dx,
            Math.floor(center.y) + dy,
            Math.floor(center.z) + dz,
          )
          if (p.distanceTo(bot.entity.position) < 1.5) continue
          if (
            solid(bot.blockAt(p.offset(0, -1, 0))) &&
            bot.blockAt(p)?.name === 'air'
          )
            candidates.push(p)
        }
    return candidates.sort(
      (a, b) => a.distanceTo(center) - b.distanceTo(center),
    )
  }
  function chooseSite() {
    for (const p of openGround(bot.entity.position, 8)) {
      const footprint = []
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++) footprint.push(p.offset(x, 0, z))
      if (
        footprint.every(
          (q) =>
            solid(bot.blockAt(q.offset(0, -1, 0))) &&
            [0, 1, 2].every((y) =>
              ['air', 'short_grass', 'tall_grass'].includes(
                bot.blockAt(q.offset(0, y, 0))?.name,
              ),
            ),
        )
      )
        return p
    }
    return null
  }
  function observation() {
    const items = bot.inventory.items()
    const feet = bot.entity.position.floored()
    const nearbyTerrain = Object.fromEntries([
      ['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1],
    ].map(([direction, dx, dz]) => {
      const next = feet.offset(dx, 0, dz)
      return [direction, {
        feet: bot.blockAt(next)?.name ?? 'unloaded',
        head: bot.blockAt(next.offset(0, 1, 0))?.name ?? 'unloaded',
        support: bot.blockAt(next.offset(0, -1, 0))?.name ?? 'unloaded',
      }]
    }))
    const near = Object.values(bot.entities).filter(
      (e) =>
        e !== bot.entity && e.position.distanceTo(bot.entity.position) < 24,
    )
    const logs = nearbyBlock((b) => isLog(b.name), 24, 'log24')
    const stone = nearbyBlock((b) => stoneNames.has(b.name), 12, 'stone12')
    const origin =
      state.shelter &&
      new Vec3(state.shelter.x, state.shelter.y, state.shelter.z)
    const blueprint = origin ? shelterBlueprint(origin) : []
    const shelterLoaded = blueprint.every((p) => bot.blockAt(p) != null)
    const shelterLocal = localShelter(origin, bot.entity.position)
    const built = blueprint.filter((p) => solid(bot.blockAt(p))).length
    return {
      health: bot.health,
      food: bot.food,
      threats: threats().map((e) => ({
        name: e.name,
        distance: Math.round(e.position.distanceTo(bot.entity.position)),
      })),
      position: bot.entity.position,
      terrain: {
        standing_on: bot.blockAt(feet.offset(0, -1, 0))?.name ?? 'unloaded',
        adjacent: nearbyTerrain,
        inspected_descent: villageCtx ? safePerchLanding(bot, villageCtx.flag.y) : null,
      },
      inventory: items.map((i) => ({ name: i.name, count: i.count })),
      resources: {
        tree: logs ? { name: logs.name, position: logs.position } : null,
        stone: stone ? { name: stone.name, position: stone.position } : null,
        workbench: table()?.position ?? null,
      },
      camp: state.camp,
      distance_from_camp: state.camp
        ? bot.entity.position.distanceTo(
            new Vec3(state.camp.x, state.camp.y, state.camp.z),
          )
        : 0,
      shelter: {
        site: origin,
        distance: origin ? Math.round(origin.distanceTo(bot.entity.position)) : null,
        local: shelterLocal,
        loaded: shelterLoaded,
        blocks: shelterLoaded ? built : null,
        total: 23,
        complete: shelterLoaded && built === 23,
        can_build_here: shelterLocal && shelterLoaded,
        archived_sites: (state.shelterHistory ?? []).map((s) => s.site),
      },
      nearby_players: near
        .filter(
          (e) =>
            e.username &&
            !/^(Cam|View|FlagSetup)/.test(e.username) &&
            e.username !== 'ClankerCam',
        )
        .map((e) => ({
          name: e.username,
          distance: Math.round(e.position.distanceTo(bot.entity.position)),
        })),
      animals: near
        .filter((e) => ['cow', 'pig', 'sheep', 'chicken'].includes(e.name))
        .map((e) => e.name),
      recent_results: state.recent.slice(-6),
      progress: progressSummary(),
      current_goal: state.plan.goal,
      ...(villageCtx
        ? (() => {
            const progress = (list) => {
              let done = 0
              for (const p of list) if (structuralBlock(bot.blockAt(p))) done++
              return { done, total: list.length, complete: done === list.length }
            }
            return {
              village: {
                ...(villageCtx.summary?.() ?? {}),
                distance_from_flag: Math.round(
                  bot.entity.position.distanceTo(villageCtx.flag),
                ),
                vegetation: { observed_blocks: vegetationTargets().length,
                  next: vegetationTarget()?.position ?? null,
                  purpose: 'Clear natural trunks and leaves for access and sightlines, even with enough wood. Upper canopy may require a closer or higher safe position.' },
                coolant_source: remoteSpring ? { position: remoteSpring,
                  distance: Math.round(bot.entity.position.distanceTo(remoteSpring)),
                  rule: 'Only Cryo Coolant filled at the cyan remote spring powers the Server. Ordinary water is for farming and survival.',
                  carried: bot.inventory.items().filter(isCoolantBucket).length } : null,
                my_home: progress(homePlan(layout.home)),
                my_home_upgrade: layout.homeUpgrade.length ? progress(homePlan(layout.homeUpgrade)) : null,
                wall: progress(layout.wall),
                wall_upgrade: progress(layout.wallUpgrade),
                gate: progress(layout.gate),
                blast_holes: holeTargets().length,
                repairable_blast_holes: new Set(repairOptions().map(({ target }) => target.toString())).size,
                farm: {
                  plots: layout.farm.length,
                  tilled: layout.farm.filter((p) => farmStage(p).ground?.name === 'farmland').length,
                  growing: layout.farm.filter((p) => farmStage(p).crop?.name === 'wheat').length,
                  ready: layout.farm.filter((p) => farmStage(p).mature).length,
                },
                roads: {
                  paved: layout.roads.filter((p) => bot.blockAt(p)?.name === 'dirt_path').length,
                  total: layout.roads.length,
                },
                torches_lit: layout.torches.filter(
                  (p) => bot.blockAt(p)?.name === 'torch',
                ).length,
                torches_total: layout.torches.length,
                threats_near_flag: threats()
                  .filter((e) => e.position.distanceTo(villageCtx.flag) < 14)
                  .map((e) => ({
                    name: e.name,
                    distance: Math.round(
                      e.position.distanceTo(villageCtx.flag),
                    ),
                  })),
                enemy_players: enemyPlayers().map((e) => ({
                  name: e.username,
                  distance: Math.round(
                    e.position.distanceTo(villageCtx.flag),
                  ),
                })),
              },
            }
          })()
        : {}),
    }
  }
  function ordinaryCandidates(obs) {
    const items = bot.inventory.items()
    const ownedGear = [...items, ...(bot.inventory.slots?.slice(5, 9) ?? []).filter(Boolean)]
    const options = {}
    const n = (match) => countItems(obs.inventory, match)
    const add = (key, description) => {
      if ((state.cooldowns[key] ?? 0) < Date.now()) options[key] = description
    }
    if (villageCtx && (safePerchLanding(bot, villageCtx.flag.y) ||
        safeLedgeLanding(bot, villageCtx.flag.y))) {
      add('descend_from_perch', 'Step off the isolated high block onto an inspected clear landing below.')
      return options
    }
    if (blockedRoutes >= 2 && rootedTreeExit(bot)) {
      add('clear_tree_exit', 'Clear the two lower logs of the rooted tree obstructing the only safe village exit.')
      return options
    }
    if (escapeTarget()) {
      add('escape_upward', 'Clear one inspected natural-terrain staircase step and climb toward the remembered surface; preserve construction.')
      return options
    }
    if (bot.food < 19 && n((name) => edible.has(name)))
      add('eat', 'Eat available food now to restore hunger and allow healing.')
    if (vegetationTarget())
      add('clear_village_vegetation', 'Clear one inspected natural trunk or leaf block around the Server for access and sightlines, even when wood stocks are full.')
    const needsWood =
      n(isPlank) < (obs.shelter.complete ? 12 : 28) && n(isLog) < 8
    if (obs.resources.tree && needsWood)
      add(
        'gather_wood',
        'Chop one reachable log and pick it up; supplies planks for tools and shelter.',
      )
    if (n(isLog) > 0 && n(isPlank) < 40)
      add('craft_planks', 'Turn logs into building planks.')
    if (n(isPlank) >= 2 && n('stick') < 4)
      add('craft_sticks', 'Craft sticks for tools.')
    if (n(isPlank) >= 4 && !obs.resources.workbench && !n('crafting_table'))
      add('craft_table', 'Craft a workbench to unlock tool recipes.')
    if (n('crafting_table'))
      add('place_table', 'Place the workbench on clear ground near camp.')
    if (
      obs.resources.workbench &&
      n(isPlank) >= 3 &&
      n('stick') >= 2 &&
      !n(isPick)
    )
      add(
        'craft_wooden_pickaxe',
        'Craft your first pickaxe so stone drops cobblestone.',
      )
    if (obs.resources.stone && n(isPick) && n('cobblestone') < 24)
      add(
        'mine_stone',
        'Mine one reachable stone/coal block with a pickaxe and collect the drop.',
      )
    if (obs.resources.workbench && n('cobblestone') >= 3 && n('stick') >= 2) {
      if (gearTier(bestEquipment(items, '_pickaxe')?.name ?? '') < 2)
        add('craft_stone_pickaxe', 'Upgrade to a durable stone pickaxe.')
      if (gearTier(bestEquipment(items, '_axe')?.name ?? '') < 2)
        add('craft_stone_axe', 'Craft a stone axe to chop trees faster.')
    }
    if (
      obs.resources.workbench &&
      n('cobblestone') >= 8 &&
      !n('furnace') &&
      !nearbyBlock((b) => b.name === 'furnace', 16)
    )
      add('craft_furnace', 'Craft a furnace for the camp.')
    if (n('furnace'))
      add('place_furnace', 'Place the furnace near the workbench.')
    if (!villageCtx && n(isShelterMaterial) >= 1 && !obs.shelter.complete &&
        obs.shelter.can_build_here)
      add(
        'build_shelter',
        'Build up to two shelter blocks with planks, cobblestone, stone or dirt; keep its doorway open. No workbench required.',
      )
    if (!villageCtx && n(isShelterMaterial) >= 1 && !obs.shelter.local && chooseSite())
      add(
        'relocate_shelter',
        'Select a reachable local shelter site. Remember the distant previous site and leave all of its blocks intact.',
      )
    if (obs.animals.length && n((name) => edible.has(name)) < 4)
      add(
        'hunt_food',
        'Hunt one nearby farm animal with an equipped tool for food.',
      )
    if (n((name) => name.endsWith('_sapling')) && saplingSite())
      add('plant_tree', 'Plant a sapling outside the village clearance zone and guest approach road.')
    const drops = Object.values(bot.entities).some(
      (e) =>
        e.name === 'item' && e.position.distanceTo(bot.entity.position) < 10 && !resourceBusy(e.position),
    )
    if (drops) add('collect_drops', 'Pick up a nearby dropped item.')
    if (
      obs.distance_from_camp > 72 &&
      (state.shelter || obs.resources.workbench)
    )
      add('return_to_camp', 'Walk back toward your remembered camp.')
    add(
      'explore',
      'Scout a short new route to find reachable wood, stone, or food.',
    )
    // ---- village candidates ------------------------------------------------
    // Role-preferred actions are listed first so the labeled fallback policy
    // does the right kind of work when Jev is unavailable.
    if (villageCtx) {
      const V = obs.village ?? {}
      const dx = bot.entity.position.x - villageCtx.flag.x
      const dz = bot.entity.position.z - villageCtx.flag.z
      const onGradedFloor = (Math.abs(dx) <= WALL_RADIUS + 0.5 &&
        Math.abs(dz) <= WALL_RADIUS + 0.5) ||
        (dz >= WALL_RADIUS - 0.5 && dz <= WALL_RADIUS + 6.5 && Math.abs(dx) <= 2.5)
      const nearVillage = onGradedFloor &&
        Math.abs(bot.entity.position.y - (villageCtx.flag.y + 1)) <= 3
      const vo = {}
      const vadd = (key, description) => {
        if ((state.cooldowns[key] ?? 0) < Date.now()) vo[key] = description
      }
      const materials = buildMaterialCount(Boolean(obs.resources.workbench))
      const wallMaterials = materials + n('dirt')
      if (nearVillage && ['guard', 'builder'].includes(state.role) &&
          V.repairable_blast_holes > 0 && n((name) => ['dirt', 'cobblestone', 'stone'].includes(name)) > 0)
        vadd('repair_blast_hole', 'Seal one blast hole in the village floor from stable neighboring ground.')
      if (nearVillage && wallMaterials >= 1 && !V.wall?.complete)
        vadd(
          'build_wall',
          'Raise up to two blocks of the perimeter wall; use gathered earth as a first barricade when stone or wood is scarce.',
        )
      if (nearVillage && (state.role ?? null) === 'builder' &&
          wallMaterials < 1 && (!V.wall?.complete || !V.my_home?.complete))
        vadd('gather_wall_earth',
          'Gather one dirt block outside the village footprint for the finite wall or a starter home.')
      if (nearVillage && materials >= 1 && !V.gate?.complete)
        vadd(
          'build_gate',
          'Raise the front gate pillars and lintel on the south road.',
        )
      if (nearVillage && wallMaterials >= 1 && !V.my_home?.complete)
        vadd('build_home', 'Raise up to two blocks of your own starter home on its fixed lot; gathered earth can start the shell.')
      if (nearVillage && materials >= 2 && V.wall?.complete && V.gate?.complete &&
          !V.wall_upgrade?.complete)
        vadd('reinforce_wall',
          'Thicken safe parts of the finished perimeter wall inward while keeping homes and the gate road open.')
      if (nearVillage && materials >= 2 && V.my_home?.complete &&
          V.my_home_upgrade && !V.my_home_upgrade.complete)
        vadd('expand_home',
          'Enlarge your finished home with a connected room and a new entrance; stop at the planned footprint.')
      if (
        nearVillage && n('torch') > 0 &&
        V.torches_lit < (V.torches_total ?? 0)
      )
        vadd(
          'place_torch',
          'Place a torch on the wall to keep monsters out of the village.',
        )
      if (nearVillage && V.farm?.ready > 0)
        vadd('harvest_wheat', 'Harvest mature wheat from the spring-fed village farm.')
      if (nearVillage && V.farm?.tilled < V.farm?.plots && n((name) => name.endsWith('_hoe')) > 0)
        vadd('till_farm', 'Till one clear plot beside the spring; the farm has eight fixed plots.')
      if (nearVillage && V.farm?.growing < V.farm?.tilled && n('wheat_seeds') > 0)
        vadd('plant_wheat', 'Sow wheat seeds in one empty irrigated plot.')
      if (nearVillage && V.farm?.growing < V.farm?.plots && n('wheat_seeds') === 0 &&
          nearbyBlock((b) => b.name === 'short_grass', 24, 'grass24', 1500))
        vadd('gather_wheat_seeds', 'Cut nearby wild grass for wheat seeds; a cut may yield none.')
      if (nearVillage && V.roads?.paved < V.roads?.total && n((name) => name.endsWith('_shovel')) > 0)
        vadd('pave_road', 'Turn one clear block of the finite village lanes into a dirt path.')
      if (obs.resources.workbench && n('cobblestone') >= 2 && n('stick') >= 2 &&
          !n((name) => name.endsWith('_hoe')) && V.farm?.tilled < V.farm?.plots)
        vadd('craft_stone_hoe', 'Craft a hoe for the spring-fed village farm.')
      if (obs.resources.workbench && n('cobblestone') >= 1 && n('stick') >= 2 &&
          !n((name) => name.endsWith('_shovel')) && V.roads?.paved < V.roads?.total)
        vadd('craft_stone_shovel', 'Craft a shovel to make the village paths.')
      if (obs.resources.workbench && n('wheat') >= 3 && n('bread') < 4)
        vadd('craft_bread', 'Bake harvested wheat into bread for food.')
      if (
        obs.resources.workbench &&
        n('cobblestone') >= 2 &&
        n('stick') >= 1 &&
        gearTier(bestEquipment(items, '_sword')?.name ?? '') < 2
      )
        vadd('craft_stone_sword', 'Craft a stone sword for guard duty.')
      if (n('coal') >= 1 && n('stick') >= 1 && n('torch') < 8)
        vadd(
          'craft_torch',
          'Craft torches from coal and sticks to light the village.',
        )
      const hasBucket = n('bucket') > 0 || n('water_bucket') > 0
      // Wooden (and golden) pickaxes break iron ore without dropping raw
      // iron; require a stone-tier pickaxe.
      const ironPick = n(
        (name) =>
          name.endsWith('_pickaxe') &&
          !name.startsWith('wooden_') &&
          !name.startsWith('golden_'),
      )
      const upgrades = [
        ['iron_sword', 2, 1], ['iron_pickaxe', 3, 2],
        ['iron_chestplate', 8, 0], ['iron_leggings', 7, 0],
        ['iron_helmet', 5, 0], ['iron_boots', 4, 0], ['iron_axe', 3, 2],
      ].filter(([name]) => gearTier(bestEquipment(ownedGear, `_${name.split('_')[1]}`)?.name ?? '') < 3)
      for (const [name, iron, sticks] of upgrades)
        if (obs.resources.workbench && n('iron_ingot') >= iron && n('stick') >= sticks)
          vadd(`craft_${name}`, `Upgrade to ${name.replaceAll('_', ' ')} using ${iron} iron ingots.`)
      if (armorUpgrade(bot)) vadd('equip_armor', 'Wear your best available armor; carrying it does not protect you.')
      if ((!hasBucket && !V.atCapacity) || upgrades.length) {
        if (!hasBucket && !V.atCapacity && n('iron_ingot') >= 3 && obs.resources.workbench)
          vadd(
            'craft_bucket',
            'Craft a bucket from three iron ingots to carry coolant.',
          )
        if (n('raw_iron') >= 1 && furnaceNearby() && n((name) => name === 'coal' || isPlank(name) || isLog(name)))
          vadd('smelt_iron', 'Smelt raw iron for better tools, weapons, armor, or a bucket.')
        if (ironPick && oreNearby() && n('raw_iron') + n('iron_ingot') < 32)
          vadd(
            'mine_iron_ore',
            'Mine one iron ore with a stone-or-better pickaxe for equipment upgrades and buckets.',
          )
      }
      const hasCoolant = items.some(coolantItem)
      if (remoteSpring && nearVillage && !hasCoolant && !n('bucket') && n('water_bucket'))
        vadd('empty_ordinary_water', 'Empty an ordinary water bucket into the drain without coolant credit, freeing the bucket for an expedition.')
      const atSpring = remoteSpring && bot.entity.position.distanceTo(remoteSpring) <= 5
      if (!V.atCapacity) {
        if (remoteSpring && !hasCoolant && n('bucket') > 0 && !atSpring)
          vadd('travel_to_coolant', 'Take one short, verified step toward the marked remote coolant spring; reassess terrain and threats en route.')
        if ((remoteSpring ? atSpring : nearVillage && !hasCoolant) && n('bucket') > 0)
          vadd(
            'scoop_water',
            remoteSpring ? 'Fill one empty bucket at the cyan remote spring to obtain Cryo Coolant.' : 'Fill your bucket at the coolant spring south of the front gate.',
          )
        if (nearVillage && hasCoolant)
          vadd(
            'feed_server',
            `Feed the Server one bucket of coolant; it boots a new villager at ${V.water?.target ?? '?'} buckets (now ${V.water?.fed ?? 0}).`,
          )
      }
      if (nearVillage && (state.role ?? null) === 'guard')
        vadd('patrol', 'Walk the perimeter on watch for creepers and guests.')
      if (!nearVillage && (!remoteSpring || hasCoolant || V.atCapacity || !n('bucket')))
        vadd('return_to_post', 'Head back toward the Server and the village.')
      const preferred = {
        guard: ['repair_blast_hole', 'attack_threat', 'clear_village_vegetation', 'build_gate', 'build_wall', 'patrol', 'reinforce_wall', 'place_torch', 'return_to_post'],
        builder: ['repair_blast_hole', 'clear_village_vegetation', 'build_home', 'build_wall', 'gather_wood', 'gather_wall_earth', 'build_gate', 'reinforce_wall', 'expand_home', 'pave_road', 'craft_stone_shovel', 'place_torch', 'return_to_post'],
        smith: ['equip_armor', 'craft_iron_sword', 'craft_iron_pickaxe', 'craft_iron_chestplate', 'craft_iron_leggings', 'craft_iron_helmet', 'craft_iron_boots', 'craft_iron_axe', 'craft_stone_sword', 'smelt_iron', 'mine_iron_ore', 'craft_torch', 'craft_bucket', 'return_to_post'],
        coolant: ['feed_server', 'empty_ordinary_water', 'scoop_water', 'travel_to_coolant', 'return_to_post', 'craft_bucket', 'mine_iron_ore', 'smelt_iron'],
        farmer: ['harvest_wheat', 'plant_wheat', 'till_farm', 'craft_stone_hoe', 'gather_wheat_seeds', 'craft_bread', 'hunt_food', 'plant_tree', 'return_to_post'],
      }[state.role ?? ''] ?? ['build_wall', 'build_home', 'reinforce_wall', 'expand_home', 'feed_server', 'scoop_water']
      const ordered = {}
      if (vo.equip_armor) ordered.equip_armor = vo.equip_armor
      const toolPrerequisites = !n(isPick) || !obs.resources.workbench || state.plan.goal === 'equip_tools'
      if (toolPrerequisites) {
        for (const key of ['place_table', 'craft_table', 'craft_wooden_pickaxe', 'craft_stone_pickaxe',
          'craft_stone_axe', 'craft_sticks', 'craft_planks'])
          if (options[key]) ordered[key] = options[key]
      }
      for (const key of preferred)
        if (vo[key] || options[key]) ordered[key] = vo[key] ?? options[key]
      for (const [key, description] of Object.entries(vo))
        if (!ordered[key]) ordered[key] = description
      const merged = { ...ordered, ...options }
      return merged
    }
    return options
  }

  function passageOptions() {
    return localPassagePlans(bot, {
      protectedBlock: (p) => constructionBlock(p) || resourceBusy(p),
      remodel: (p) => ownExtensionWalls.has(p.toString()) && !resourceBusy(p),
    })
  }
  function recoveryOptions() {
    const choices = new Map()
    for (const route of localRecoveryRoutes(bot)) {
      const p = route.destination
      choices.set(recoveryKey('recover_walk', p), {
        ...route, kind: 'walk',
        description: `Try an inspected ${route.steps}-step route ${route.direction} to (${p.x},${p.y},${p.z}); no digging; ${route.overheadClear ? 'three overhead blocks inspected clear' : 'covered or unverified overhead'}. Reassess after arrival.`,
      })
    }
    for (const plan of passageOptions()) {
      const p = plan.destination
      choices.set(recoveryKey('recover_passage', p), { ...plan, kind: 'passage',
        description: `Open a two-block-high passage ${plan.direction} to inspected clear ground (${p.x},${p.y},${p.z}); remove ${plan.clear.map((b) => b.name).join(' + ')}. ${plan.clear.some((b) => b.remodel) ? 'Remodel your own extension sidewall into a remembered doorway; preserve roof, bed and supplies.' : 'Clear only natural terrain.'} Verify the opening and walk through.` })
    }
    const target = escapeTarget()
    if (target) {
      // Use the same conservative protection as the escape executor.
      const protect = (p) => resourceBusy(p) || (constructionBlock(p) && !(layout &&
        p.y === layout.flag.y && ['dirt', 'grass_block'].includes(bot.blockAt(p)?.name) &&
        !villageConstruction.has(p.toString())))
      for (const plan of localEscapePlans(bot, target, protect)) {
        const p = plan.destination
        choices.set(recoveryKey('recover_stair', p), { ...plan, kind: 'stair',
          description: `Climb one inspected stair to (${p.x},${p.y},${p.z}), clearing ${plan.clear.length} natural blocks; preserve all construction.` })
      }
    }
    return choices
  }

  function progressSummary() {
    const local = localContext(bot), accessBlocked = progress.accessBlocked(local.accessKey)
    const summary = progress.summary(local.key)
    return { ...summary, stalled: summary.stalled || accessBlocked,
      access_blocked: accessBlocked, preserved_openings: state.accessOpenings }
  }
  function candidates(obs) {
    const local = localContext(bot), context = local.key
    const accessBlocked = progress.accessBlocked(local.accessKey)
    const ordinary = Object.fromEntries(Object.entries(ordinaryCandidates(obs))
      .filter(([key]) => !progress.blocked(context, key))
      .filter(([key]) => !accessBlocked || /^(craft_|equip_|eat$|attack_threat$)/.test(key)))
    const vegetation = vegetationTarget()
    if (vegetation && (!accessBlocked || bot.canDigBlock(vegetation)) &&
        !progress.blocked(context, 'clear_village_vegetation') &&
        (state.cooldowns.clear_village_vegetation ?? 0) < Date.now())
      ordinary.clear_village_vegetation = `Clear one inspected natural ${vegetation.name} at ${vegetation.position} around the Server; opens access and sightlines even when wood stocks are full. Preserve buildings and placed leaves.`
    // Returning to an already blocked place must not wait out the ledger just
    // because the preceding trip counted as movement elsewhere.
    const stalled = accessBlocked || progress.stalled(context) ||
      (!Object.keys(ordinary).length && progress.summary(context).failed_here.length >= 2)
    const options = {}
    if (stalled) for (const [key, option] of recoveryOptions()) {
      if (!progress.blocked(context, key) && (state.cooldowns[key] ?? 0) < Date.now())
        options[key] = option.description
    }
    Object.assign(options, ordinary)
    // No retry masquerading as a new route. Stay responsive and wait for a
    // fresh plan, cooldown expiry or an observed environment change.
    if (!Object.keys(options).length)
      options.wait_for_change = 'No unblocked executable action. Hold safely, report the obstruction, and reassess local terrain; do not claim progress.'
    return options
  }

  async function execute(action, { source = null } = {}) {
    if (action === 'wait_for_change') {
      await sleep(1500)
      return { waiting: true, reason: 'no_unblocked_action', progress: progressSummary() }
    }
    const before = bot.entity.position.clone(), context = localContext(bot)
    const inventory = () => JSON.stringify(bot.inventory.items().map((i) => [i.name, i.count]).sort())
    const beforeInventory = inventory(), revision = skillRevision
    let result, error
    try {
      result = await executeSkill(action)
      return result
    } catch (e) {
      error = e
      throw e
    } finally {
      if (revision === skillRevision && bot.entity && bot.health > 0) {
        const after = bot.entity.position.clone(), current = localContext(bot)
        const changed = result?.clearedVegetation === 1 || inventory() !== beforeInventory ||
          (before.floored().equals(after.floored()) && current.terrain !== context.terrain)
        const evidence = progress.record({ context: context.key, accessContext: context.accessKey, action, before, after, changed,
          ok: !error, error: error ?? (!changed && before.distanceTo(after) < 0.75 ? 'No observed movement, block or inventory progress' : null), source })
        log('action_progress', evidence)
      }
    }
  }

  async function openPassage(plan) {
    const revision = skillRevision, before = bot.entity.position.clone()
    const check = () => {
      if (skillRevision !== revision || bot.health <= 0 || emergency()) throw new Error('Passage interrupted')
    }
    bot.pathfinder.setGoal(null); bot.clearControlStates()
    for (const expected of plan.clear) {
      check()
      const current = passageOptions().find((p) => p.destination.equals(plan.destination))
      const fresh = current?.clear.find((b) => b.position.equals(expected.position))
      if (!fresh || fresh.stateId !== expected.stateId) throw new Error('Passage changed; inspect again')
      const block = bot.blockAt(expected.position)
      const tool = bestEquipment(bot.inventory.items(), block.name.endsWith('_planks') ? '_axe' : '_pickaxe')
      if (tool) await bot.equip(tool, 'hand')
      if (!bot.canDigBlock(block)) throw new Error('Passage block out of reach')
      // Reserve the whole doorway before mutation so interruptions/restarts cannot
      // make the construction skill seal a half-finished exit again.
      if (plan.clear.some((b) => b.remodel)) for (const p of [plan.doorway, plan.doorway.offset(0, 1, 0)])
        if (ownExtensionWalls.has(p.toString()) && !state.accessOpenings.includes(p.toString())) state.accessOpenings.push(p.toString())
      let confirmed = false
      const update = (packet) => {
        if (expected.position.equals(new Vec3(packet.location.x, packet.location.y, packet.location.z)) &&
            packet.type === bot.registry.blocksByName.air.minStateId) confirmed = true
      }
      bot._client.on('block_change', update)
      try {
        await bounded(() => bot.dig(block, true), escapeDigBudget(bot.digTime(block)), () => bot.stopDigging())
        const deadline = Date.now() + 1800
        while (!confirmed && Date.now() < deadline) await sleep(50)
        if (!confirmed) throw new Error('Passage block removal not confirmed by server')
      } finally { bot._client.removeListener('block_change', update) }
      log('passage_block_cleared', { position: expected.position, block: expected.name, remodel: expected.remodel })
    }
    check()
    const activeMoves = movements, canDig = activeMoves.canDig
    activeMoves.canDig = false
    try {
      await walk(new goals.GoalBlock(plan.destination.x, plan.destination.y, plan.destination.z), 6500)
      check()
      if (bot.entity.position.distanceTo(plan.destination.offset(0.5, 0, 0.5)) > 0.8)
        throw new Error('Passage traversal not confirmed')
      return { openedPassage: true, cleared: plan.clear.length, moved: before.distanceTo(bot.entity.position), position: bot.entity.position.clone() }
    } finally { activeMoves.canDig = canDig }
  }
  async function executeSkill(action) {
    if (action.startsWith('recover_walk:') || action.startsWith('recover_stair:') || action.startsWith('recover_passage:')) {
      const option = recoveryOptions().get(action)
      if (!option) throw new Error('Recovery destination is no longer locally safe')
      const before = bot.entity.position.clone()
      const activeMoves = movements, previousCanDig = activeMoves.canDig
      escaping = true
      try {
        if (option.kind === 'passage') return await openPassage(option)
        if (option.kind === 'stair') return await escapeUpwardStep(option.destination)
        activeMoves.canDig = false
        await walk(new goals.GoalBlock(option.destination.x, option.destination.y, option.destination.z), 6500)
        if (before.distanceTo(bot.entity.position) < 0.75) throw new Error('Recovery made no positional progress')
        return { recovered: true, destination: option.destination, position: bot.entity.position.clone(),
          moved: Math.round(before.distanceTo(bot.entity.position) * 100) / 100 }
      } finally { escaping = false; activeMoves.canDig = previousCanDig }
    }
    const items = bot.inventory.items()
    if (action === 'descend_from_perch') return descendFromPerch()
    if (action === 'clear_tree_exit') return clearRootedTreeExit()
    if (action === 'escape_upward') return escapeUpward()
    if (action === 'flee') {
      const threat = threats()[0]
      if (!threat) return { safe: true }
      const p = bot.entity.position
      const dx = p.x - threat.position.x,
        dz = p.z - threat.position.z
      const angle = Math.atan2(dz, dx)
      const distance = bot.entity.isInWater ? 3 : 8
      let lastError
      // Alternate escape sides after a failed route, staying in the half-plane
      // away from the threat instead of retrying one impassable cliff forever.
      fleeing = true
      try {
        for (const offset of [0, Math.PI / 3, -Math.PI / 3]) {
          const bearing = angle + (fleeTurn % 2 ? -offset : offset)
          try {
            await walk(new goals.GoalNearXZ(
              Math.floor(p.x + Math.cos(bearing) * distance),
              Math.floor(p.z + Math.sin(bearing) * distance),
              1,
            ), 2500)
            fleeTurn = 0
            return { retreatedFrom: threat.name, safe: !emergency(), position: bot.entity.position }
          } catch (error) {
            lastError = error
          }
        }
        fleeTurn++
        throw lastError
      } finally {
        fleeing = false
      }
    }
    if (action === 'eat') {
      const food = items.find((i) => edible.has(i.name))
      if (!food) throw Error('Food disappeared')
      await bot.equip(food, 'hand')
      await bot.consume()
      return { ate: food.name }
    }
    if (action === 'gather_wood') {
      const b = nearbyBlock((b) => isLog(b.name), 24, 'log24')
      if (!b) throw Error('No reachable tree')
      return dig(b, '_axe')
    }
    if (action === 'mine_stone') {
      const b = nearbyBlock((b) => stoneNames.has(b.name), 12, 'stone12')
      if (!b) throw Error('No reachable stone')
      return dig(b, '_pickaxe')
    }
    if (action === 'craft_planks') {
      const logItem = items.find((i) => isLog(i.name))
      const plank = logItem.name
        .replace(/_(log|stem)$/, '_planks')
        .replace(/^stripped_/, '')
      return craft(plank, Math.min(logItem.count, 4))
    }
    if (action.startsWith('craft_'))
      return craft(
        action.slice(6) === 'table'
          ? 'crafting_table'
          : action.slice(6) === 'sticks'
            ? 'stick'
            : action.slice(6),
      )
    if (action === 'place_table' || action === 'place_furnace') {
      const name = action === 'place_table' ? 'crafting_table' : 'furnace'
      const p = openGround(bot.entity.position)[0]
      if (!p) throw Error('No clear ground')
      const result = await place(
        p,
        items.find((i) => i.name === name),
      )
      if (action === 'place_table') state.camp = { ...p }
      return result
    }
    if (action === 'relocate_shelter') {
      if (localShelter(state.shelter, bot.entity.position))
        throw new Error('The current shelter is already local')
      const site = chooseSite()
      if (!site) throw new Error('No flat clear shelter site nearby')
      const previous = { ...state.shelter }
      state.shelterHistory ??= []
      state.shelterHistory.push({ site: previous, reason: 'distant_site', at: new Date().toISOString() })
      state.shelter = { ...site }
      log('shelter_relocated', { previous, position: site, preservedPreviousBlocks: true })
      return { selectedSite: site, previousSite: previous, placed: 0 }
    }
    if (action === 'build_shelter') {
      if (!localShelter(state.shelter, bot.entity.position))
        throw new Error('Shelter is too far away; select a local site or return first')
      if (!state.shelter) {
        const site = chooseSite()
        if (!site) throw Error('No flat clear shelter site nearby')
        state.shelter = { ...site }
        log('shelter_site', { position: site })
      }
      const origin = new Vec3(state.shelter.x, state.shelter.y, state.shelter.z)
      let placed = 0
      for (const p of shelterBlueprint(origin)) {
        if (solid(bot.blockAt(p))) continue
        const b = bot.blockAt(p)
        if (['short_grass', 'tall_grass'].includes(b?.name))
          await dig(b, '_axe')
        const material = bot.inventory.items().find((i) => isShelterMaterial(i.name))
        if (!material) break
        const result = await place(p, material)
        if (result.placed && ++placed === 2) break
      }
      return { placed, site: state.shelter }
    }
    if (action === 'plant_tree') {
      const sapling = items.find((i) => i.name.endsWith('_sapling'))
      const p = saplingSite()
      if (!p) throw Error('No suitable soil')
      return place(p, sapling)
    }
    if (action === 'clear_village_vegetation') {
      vegetationTargets(true)
      const block = vegetationTarget()
      if (!block) throw new Error('No inspected village vegetation within safe working height')
      const release = claimResource(block)
      try {
        await reach(block)
        if (bot.blockAt(block.position)?.name !== block.name) throw new Error('Vegetation changed before clearing')
        const tool = bestEquipment(bot.inventory.items(), '_axe')
        if (tool) await bot.equip(tool, 'hand')
        await bounded(() => bot.dig(block), 10000, () => bot.stopDigging())
        if (!bot.blockAt(block.position) || bot.blockAt(block.position).name === block.name)
          throw new Error('Vegetation clearing was not confirmed by the server')
        vegetationCache = null
        log('village_vegetation_cleared', { block: block.name, position: block.position })
        return { clearedVegetation: 1, block: block.name, position: block.position }
      } catch (error) {
        blocked.set(block.position.toString(), Date.now() + 30000)
        throw error
      } finally { release() }
    }
    if (action === 'hunt_food') {
      const animal = Object.values(bot.entities)
        .filter(
          (e) =>
            ['cow', 'pig', 'sheep', 'chicken'].includes(e.name) &&
            e.position.distanceTo(bot.entity.position) < 24,
        )
        .sort(
          (a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position),
        )[0]
      if (!animal) throw Error('Animal moved away')
      const tool =
        items.find((i) => i.name === 'stone_axe') ??
        items.find((i) => i.name.endsWith('_sword'))
      if (tool) await bot.equip(tool, 'hand')
      const deadline = Date.now() + 15000
      while (bot.entities[animal.id] && Date.now() < deadline) {
        if (animal.position.distanceTo(bot.entity.position) > 2.8)
          await walk(new goals.GoalFollow(animal, 2), 6000)
        await bot.lookAt(animal.position.offset(0, 0.8, 0))
        bot.attack(animal)
        await sleep(1000)
      }
      await collect(animal.position).catch(() => {})
      return { hunted: animal.name, defeated: !bot.entities[animal.id] }
    }
    if (action === 'collect_drops') {
      const drop = Object.values(bot.entities)
        .filter(
          (e) =>
            e.name === 'item' &&
            e.position.distanceTo(bot.entity.position) < 12 && !resourceBusy(e.position),
        )
        .sort(
          (a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position),
        )[0]
      if (!drop) throw Error('Drop disappeared')
      const before = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }))
      await collectItem(drop, 1)
      const collected = inventoryGains(before, bot.inventory.items())
      if (!collected.length) throw Error('Dropped item did not reach inventory')
      return { collectedAt: drop.position, collected }
    }
    if (action === 'return_to_camp') {
      const p = state.camp
      if (!p) throw new Error('No remembered camp')
      return approach(p, 4)
    }
    if (action === 'explore') {
      const p = bot.entity.position.clone()
      // Walk toward visible resources before choosing a blind scouting bearing.
      // Scanning a 64-block cube for every scouting turn can monopolize the
      // controller event loop and delay movement packets for the whole cast.
      // Reuse the nearby observation first, then search a smaller horizon.
      const landmark = nearbyBlock((b) => isLog(b.name), 24, 'log24') ??
        nearbyBlock((b) => isLog(b.name), 32, 'log32', 20000, 16)
      const angle = landmark
        ? Math.atan2(landmark.position.z - p.z, landmark.position.x - p.x)
        : scoutStep * 2.39996 + (bot.username.charCodeAt(0) % 6)
      let lastError
      for (const target of scoutingTargets(p, angle, failedScouts)) {
        try {
          await walk(new goals.GoalNearXZ(target.x, target.z, 1), 3500)
          const moved = p.distanceTo(bot.entity.position)
          if (moved < 0.75) throw new Error('Scouting made no positional progress')
          scoutStep++
          failedScouts = 0
          return { scouted: bot.entity.position.clone(), moved: Math.round(moved * 10) / 10 }
        } catch (error) {
          lastError = error
          log('scout_route_failed', { target, error: String(error) })
          if (landmark) blocked.set(landmark.position.toString(), Date.now() + 120000)
        }
      }
      scoutStep++
      failedScouts += 3
      // Empty-path failures can arrive immediately; bound retry pressure even
      // when exploration is the only remaining candidate during cooldowns.
      await sleep(700)
      throw lastError
    }
    if (villageCtx) {
      if (action === 'equip_armor') {
        const upgrade = armorUpgrade(bot)
        if (!upgrade) throw new Error('No armor upgrade available')
        await bot.equip(upgrade.item, upgrade.destination)
        if (bot.inventory.slots[upgrade.slot]?.name !== upgrade.item.name)
          throw new Error('Armor equip was not confirmed')
        return { equipped: upgrade.item.name, destination: upgrade.destination }
      }
      if (action === 'travel_to_coolant') {
        if (!remoteSpring) throw new Error('No remote coolant spring configured')
        const result = await approach(remoteSpring, 4)
        return { ...result, destination: 'coolant_spring', arrived: result.returned }
      }
      if (action === 'repair_blast_hole') return repairBlastHole()
      if (action === 'till_farm') return tendFarm()
      if (action === 'plant_wheat') return sowWheat()
      if (action === 'harvest_wheat') return harvestWheat()
      if (action === 'pave_road') return paveRoad()
      if (action === 'gather_wheat_seeds') {
        const grass = nearbyBlock((b) => b.name === 'short_grass', 24, 'grass24', 1500)
        if (!grass) throw new Error('No nearby wild grass for seeds')
        const result = await dig(grass)
        return { cutGrass: grass.position, collected: result.collected }
      }
      if (action === 'build_wall') {
        const result = await buildFrom(layout.wall, 2, { allowDirt: true, nearest: true })
        return { ...result, structure: 'wall' }
      }
      if (action === 'gather_wall_earth') {
        const ground = wallEarthNearby()
        if (!ground) throw new Error('No safe exterior earth nearby')
        return dig(ground, '_shovel')
      }
      if (action === 'reinforce_wall') {
        const result = await buildFrom(layout.wallUpgrade)
        return { ...result, structure: 'wall_upgrade' }
      }
      if (action === 'build_gate') {
        const result = await buildFrom(layout.gate)
        return { ...result, structure: 'gate' }
      }
      if (action === 'build_home') {
        const result = await buildFrom(layout.home, 2, { allowDirt: true })
        return { ...result, structure: 'home' }
      }
      if (action === 'expand_home') {
        const result = await buildFrom(layout.homeUpgrade)
        return { ...result, structure: 'home_upgrade' }
      }
      if (action === 'place_torch') {
        const torch = items.find((i) => i.name === 'torch')
        if (!torch) throw new Error('Torch disappeared')
        const spot = layout.torches.find(
          (p) =>
            bot.blockAt(p)?.name === 'air' &&
            solid(bot.blockAt(p.offset(0, -1, 0))),
        )
        if (!spot) throw new Error('No open torch spot on the wall')
        return place(spot, torch)
      }
      if (action === 'mine_iron_ore') {
        const b = oreNearby()
        if (!b) throw new Error('No reachable iron ore')
        return dig(b, '_pickaxe')
      }
      if (action === 'smelt_iron') return smeltIron()
      if (action === 'scoop_water') return scoopWater()
      if (action === 'feed_server') return feedServer()
      if (action === 'empty_ordinary_water') return feedServer({ disposeOrdinary: true })
      if (action === 'patrol') return patrolOnce()
      if (action === 'return_to_post') {
        return approach(layout.flag, 6, {
          minY: layout.flag.y + 0.5, maxY: layout.flag.y + 1.5,
        })
      }
      if (action === 'attack_threat') return attackThreat()
    }
    throw new Error(`Unsupported action ${action}`)
  }
  return {
    capabilities: () => ({
      supported_actions: [
        'flee', 'eat', 'gather_wood', 'mine_stone', 'craft_planks', 'craft_sticks',
        'craft_table', 'place_table', 'craft_wooden_pickaxe', 'craft_stone_pickaxe',
        'craft_stone_axe', 'craft_furnace', 'place_furnace', 'hunt_food',
        'plant_tree', 'collect_drops', 'return_to_camp', 'explore', 'escape_upward',
        'descend_from_perch', 'clear_tree_exit',
        ...(villageCtx
          ? ['clear_village_vegetation', 'build_wall', 'gather_wall_earth', 'build_gate', 'build_home', 'reinforce_wall',
              'expand_home', 'repair_blast_hole', 'till_farm', 'plant_wheat',
              'harvest_wheat', 'gather_wheat_seeds', 'pave_road',
              'craft_stone_hoe', 'craft_stone_shovel', 'craft_bread', 'place_torch',
              'craft_stone_sword', 'craft_torch', 'craft_bucket', 'mine_iron_ore',
              'smelt_iron', 'scoop_water', 'feed_server', 'patrol',
              'travel_to_coolant', 'empty_ordinary_water', 'craft_iron_sword', 'craft_iron_pickaxe',
              'craft_iron_axe', 'craft_iron_helmet', 'craft_iron_chestplate',
              'craft_iron_leggings', 'craft_iron_boots', 'equip_armor',
              'return_to_post', 'attack_threat']
          : ['build_shelter', 'relocate_shelter']),
      ],
      navigation: {
        observations: 'loaded local blocks and entities; darkness does not hide them',
        max_drop_blocks: villageCtx ? 1 : 2,
        pillar_climbing: false,
        recovery: 'short alternate routes; safe terrain clearing; optional remembered doorway in own extension sidewalls only; preserve roofs, beds, fixtures and other homes',
        explicit_recovery_targets: 'recover_walk:x:y:z, recover_stair:x:y:z and recover_passage:x:y:z are supplied only after repeated no-progress attempts; choose an offered key, never invent coordinates.',
      },
      shelter: {
        materials: ['planks', 'cobblestone', 'stone', 'dirt'],
        workbench_required: false,
        max_site_distance: 32,
        max_height_difference: 8,
        preserve_previous_sites: true,
      },
      execution: 'Only currently offered action keys are executable; targets come from loaded local blocks.',
    }),
    observation,
    emergency,
    candidates,
    execute,
    progress: progressSummary,
    stop() {
      skillRevision++
      escapeSession = null
      blockedRoutes = 0
      for (const [key, claim] of resourceClaims)
        if (claim.owner === claimOwner) resourceClaims.delete(key)
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
      bot.stopDigging()
    },
  }
}
