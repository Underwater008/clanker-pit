import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { setTimeout as sleep } from 'node:timers/promises'
import { craftConfirmed, craftableRecipe } from './crafting.mjs'
import {
  wallBlueprint,
  wallReinforcementBlueprint,
  gateBlueprint,
  torchSpots,
  homeBlueprint,
  homeExtensionBlueprint,
  homeLot,
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
    'Repair shallow blast holes, tend spring-fed wheat, pave the planned lanes, reinforce the wall, and enlarge homes only within their lots.',
  stockpile_defense:
    'Prepare stone swords, torches, raw iron and buckets so the village can defend itself.',
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
export function localEscapePlans(bot, target, protectedBlock = () => false) {
  const origin = bot.entity.position.floored()
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
  const blocked = new Map()
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
        ...layout.farm,
        ...layout.roads,
      ].map((p) => p.toString())
    : [])
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
    moves.canDig = true
    moves.digCost = 2 // Prefer going around; clear ordinary terrain when needed.
    moves.exclusionAreasBreak.push((block) => {
      if (constructionBlock(block.position) || resourceBusy(block.position)) return 100
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
    }
    moves.allow1by1towers = false
    moves.allowParkour = false
    moves.maxDropDown = 2
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
    const danger = (entity) => !escapeTarget() || Date.now() - lastHurtAt < 2500 ||
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
  function nearbyBlock(matching, radius = 18) {
    return bot
      .findBlocks({ matching, maxDistance: radius, count: 36 })
      .map((p) => bot.blockAt(p))
      .filter(
        (b) =>
          b &&
          !((isLog(b.name) || stoneNames.has(b.name) || ironOreNames.has(b.name)) &&
            (constructionBlock(b.position) || resourceBusy(b.position))) &&
          (blocked.get(b.position.toString()) ?? 0) < Date.now() &&
          b.position.y >= bot.entity.position.y - 3 &&
          b.position.y <= bot.entity.position.y + 5,
      )
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position),
      )[0]
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
    try {
      const result = await navigateWithRecovery({ bot, goal, ms, run: walkOnce, emergency, log })
      blockedRoutes = 0
      return result
    } catch (error) {
      blockedRoutes++
      lastBlockedRoute = Date.now()
      throw error
    }
  }
  function escapeTarget() {
    const target = escapeSession ?? (villageCtx ? villageCtx.flag.offset(0, 1, 0) : state.camp)
    if (!target || bot.entity.isInWater) return null
    if (bot.entity.position.y >= target.y - 0.1 ||
        Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) > 32) {
      escapeSession = null
      return null
    }
    if (!escapeSession && (blockedRoutes < 2 || Date.now() - lastBlockedRoute > 60000 ||
        target.y - bot.entity.position.y < 3)) return null
    escapeSession ??= new Vec3(target.x, target.y, target.z)
    return escapeSession
  }
  async function escapeUpward() {
    escaping = true
    try { return await escapeUpwardStep() }
    finally { escaping = false }
  }
  async function escapeUpwardStep() {
    const revision = skillRevision
    const interrupted = () => revision !== skillRevision || bot.health <= 0 || emergency()
    const target = escapeTarget()
    if (!target) throw new Error('No blocked underground route to recover')
    const protectedBlock = (position) => constructionBlock(position) || resourceBusy(position)
    const plan = localEscapePlans(bot, target, protectedBlock)[0]
    if (!plan) {
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
    if (
      bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 3.8
    )
      await walk(
        new goals.GoalGetToBlock(
          block.position.x,
          block.position.y,
          block.position.z,
        ),
      )
    if (
      bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.5
    )
      throw new Error('Block still out of reach')
  }
  async function approach(position, range) {
    const target = new Vec3(position.x, position.y, position.z)
    const before = bot.entity.position.clone()
    if (before.distanceTo(target) <= range)
      return { returned: true, remaining: 0, moved: 0 }
    const dx = target.x - before.x, dz = target.z - before.z
    const horizontal = Math.hypot(dx, dz)
    // Distant remembered coordinates are a direction, not a single enormous
    // A* search. Each action must make verified local progress toward them.
    const goal = horizontal > 14
      ? new goals.GoalNearXZ(before.x + dx / horizontal * 12, before.z + dz / horizontal * 12, 1)
      : new goals.GoalNear(target.x, target.y, target.z, range)
    await walk(goal, 9000)
    const remaining = bot.entity.position.distanceTo(target)
    const moved = before.distanceTo(bot.entity.position)
    if (remaining > range && moved < 0.75)
      throw new Error('Return route made no positional progress')
    return {
      returned: remaining <= range,
      remaining: Math.round(remaining),
      moved: Math.round(moved * 10) / 10,
    }
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
    if (item) {
      await walk(
        new goals.GoalNear(
          item.position.x,
          item.position.y,
          item.position.z,
          0,
        ),
        7000,
      )
      await sleep(650)
    }
  }
  async function dig(block, toolSuffix) {
    const resource = isLog(block.name) || stoneNames.has(block.name) || ironOreNames.has(block.name)
    const release = resource ? claimResource(block) : () => {}
    const before = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }))
    try {
      await reach(block)
      if (bot.blockAt(block.position)?.name !== block.name)
        throw new Error('Resource changed before gathering began')
      const items = bot.inventory.items()
      const tools = items.filter((i) =>
        i.name.endsWith(toolSuffix ?? '_pickaxe'),
      )
      const tool = tools.find((i) => i.name.startsWith('stone_')) ?? tools[0]
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
            : stoneNames.has(block.name) ? 'cobblestone' : null
      if (resource && !gained.some((item) => item.name === expected)) {
        log('gather_uncollected', { block: block.name, position: block.position, gained,
          error: pickupError ? String(pickupError) : 'No matching item reached inventory' })
        throw new Error(`Gathering ${block.name} did not deliver ${expected} to inventory`)
      }
      return { block: block.name, position: block.position, collected: gained }
    } catch (e) {
      blocked.set(block.position.toString(), Date.now() + 120000)
      throw e
    } finally {
      release()
    }
  }
  const table = () => nearbyBlock((b) => b.name === 'crafting_table', 24)
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
  async function place(position, item) {
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
        2 &&
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
    const crouch = ['crafting_table', 'furnace', 'chest'].includes(
      reference.name,
    )
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
  function constructionMaterials(hasWorkbench = Boolean(table())) {
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
    return {
      count: countItems(mineral, () => true) + usablePlanks + (logItem ? usableLogs : 0),
      first: mineral[0] ?? planksItem ?? logItem,
    }
  }
  const buildMaterialCount = (hasWorkbench) => constructionMaterials(hasWorkbench).count
  const firstBuildMaterial = () => constructionMaterials().first
  /** Place up to `perAction` missing blocks of a blueprint, in order. */
  async function buildFrom(blueprint, perAction = 2) {
    let placed = 0
    for (const p of blueprint) {
      if (solid(bot.blockAt(p))) continue
      const occupant = bot.blockAt(p)
      if (['short_grass', 'tall_grass'].includes(occupant?.name))
        await dig(occupant, '_axe').catch(() => {})
      const material = firstBuildMaterial()
      if (!material) break
      const result = await place(p, material)
      if (result.placed && ++placed === perAction) break
    }
    return { placed }
  }
  const farmStage = (p) => {
    const ground = bot.blockAt(p), crop = bot.blockAt(p.offset(0, 1, 0))
    return { ground, crop, mature: crop?.name === 'wheat' && Number(crop.getProperties()?.age) >= 7 }
  }
  const holeTargets = () => blastHoleTargets(layout.flag, (p) => bot.blockAt(p))
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
    const target = holeTargets().sort((a, b) =>
      a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
    if (!target) throw new Error('No shallow dry blast hole on the village floor')
    const item = bot.inventory.items().find((i) => ['dirt', 'cobblestone', 'stone'].includes(i.name))
    if (!item) throw new Error('No dirt or stone to fill the hole')
    await walk(new goals.GoalNear(target.x, target.y + 1, target.z, 2), 9000)
    const support = bot.blockAt(target.offset(0, -1, 0))
    if (!solid(support) || bot.blockAt(target)?.name !== 'air')
      throw new Error('Blast-hole support changed before repair')
    if (bot.entity.position.distanceTo(support.position.offset(0.5, 1, 0.5)) > 4.4)
      throw new Error('Blast-hole support is out of placement reach')
    const available = bot.inventory.items().find((i) => i.name === item.name && i.count > 0)
    if (!available) throw new Error('Repair material left inventory')
    await bot.equip(available, 'hand')
    if (bot.heldItem?.name !== available.name) throw new Error('Repair material is not held')
    await bounded(() => bot._placeBlockWithOptions(support, new Vec3(0, 1, 0),
      { forceLook: true, swingArm: 'right' }), 7000)
    await awaitBlock(target, (b) => b?.name === available.name)
    return { placed: available.name, position: target, repairedHole: true }
  }
  async function tendFarm() {
    const plot = layout.farm.find((p) => {
      const { ground, crop } = farmStage(p)
      return ['grass_block', 'dirt'].includes(ground?.name) && crop?.name === 'air'
    })
    if (!plot) throw new Error('No untilled clear plot in the planned farm')
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
      bot.blockAt(p.offset(0, 1, 0))?.name === 'air')
    if (!spot) throw new Error('No unpaved clear lane in the village plan')
    return { ...await useToolOnGround(spot, '_shovel', 'dirt_path'), road: true }
  }
  const oreNearby = () => nearbyBlock((b) => ironOreNames.has(b.name), 16)
  const furnaceNearby = () => nearbyBlock((b) => b.name === 'furnace', 16)
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
    const water = layout.anatomy.spring
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
    // Buckets use the held-item packet, not block placement. An infinite
    // spring can refill within the same tick, so inventory is the proof.
    await bot.lookAt(water.position.offset(0.5, 0.8, 0.5), true)
    bot.activateItem()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (countItems(bot.inventory.items(), 'water_bucket') > fullBefore &&
          countItems(bot.inventory.items(), 'bucket') < emptyBefore)
        return { filledBucket: true }
      await sleep(50)
    }
    throw new Error('Bucket did not fill at the spring')
  }
  /**
   * Feed the Server one bucket of coolant. The pour is server-confirmed by
   * the water block appearing in the basin. The Server drinks on its own
   * schedule (the guest gateway drains the basin via RCON — a match-
   * controller mechanic, labeled): until it does, the basin stays full and
   * further feeds wait. The water is genuinely consumed — the bot walks back
   * to the spring for every bucket. The whole cycle runs through the shared
   * basin lock so pours can never interleave between clankers.
   */
  async function feedServer() {
    const cycle = async () => {
      const { basinFloor, basinHole } = layout.anatomy
      // The rim can occlude the basin floor from ground level. Find an actual
      // visible top face before using the bucket, even if this means stepping
      // onto the rim; distance alone does not guarantee the pour destination.
      const pourGoal = new goals.GoalPlaceBlock(basinHole, bot.world, {
        range: 4.25, LOS: true, faces: [new Vec3(0, -1, 0)],
      })
      await walk(pourGoal)
      const floorBlock = bot.blockAt(basinFloor)
      if (!solid(floorBlock)) throw new Error('Server basin floor is missing')
      if (bot.blockAt(basinHole)?.name === 'water')
        throw new Error('The Server is still drinking the last bucket')
      const full = bot.inventory.items().find((i) => i.name === 'water_bucket')
      if (!full) throw new Error('No water bucket to feed the Server')
      const fullBefore = countItems(bot.inventory.items(), 'water_bucket')
      const emptyBefore = countItems(bot.inventory.items(), 'bucket')
      await bot.equip(full, 'hand')
      await bot.lookAt(basinFloor.offset(0.5, 1, 0.5), true)
      bot.activateItem()
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (bot.blockAt(basinHole)?.name === 'water' &&
            countItems(bot.inventory.items(), 'water_bucket') < fullBefore &&
            countItems(bot.inventory.items(), 'bucket') > emptyBefore)
          return { fedCoolant: true }
        await sleep(50)
      }
      throw new Error('Server basin pour was not confirmed by water and an emptied bucket')
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
      bot.inventory.items().find((i) => i.name === 'iron_sword') ??
      bot.inventory.items().find((i) => i.name === 'stone_sword') ??
      bot.inventory.items().find((i) => i.name.endsWith('_sword')) ??
      bot.inventory.items().find((i) => i.name === 'stone_axe')
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
    const near = Object.values(bot.entities).filter(
      (e) =>
        e !== bot.entity && e.position.distanceTo(bot.entity.position) < 24,
    )
    const logs = nearbyBlock((b) => isLog(b.name), 24)
    const stone = nearbyBlock((b) => stoneNames.has(b.name), 12)
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
      current_goal: state.plan.goal,
      ...(villageCtx
        ? (() => {
            const progress = (list) => {
              let done = 0
              for (const p of list) if (solid(bot.blockAt(p))) done++
              return { done, total: list.length, complete: done === list.length }
            }
            return {
              village: {
                ...(villageCtx.summary?.() ?? {}),
                distance_from_flag: Math.round(
                  bot.entity.position.distanceTo(villageCtx.flag),
                ),
                my_home: progress(layout.home),
                my_home_upgrade: layout.homeUpgrade.length ? progress(layout.homeUpgrade) : null,
                wall: progress(layout.wall),
                wall_upgrade: progress(layout.wallUpgrade),
                gate: progress(layout.gate),
                blast_holes: holeTargets().length,
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
  function candidates(obs) {
    const options = {}
    const n = (match) => countItems(obs.inventory, match)
    const add = (key, description) => {
      if ((state.cooldowns[key] ?? 0) < Date.now()) options[key] = description
    }
    if (escapeTarget())
      return { escape_upward: 'Recover from the blocked underground route: clear one inspected natural-terrain staircase step and climb toward the remembered surface. Bare hands may clear stone slowly; preserve construction and avoid fluid or falling terrain.' }
    if (bot.food < 19 && n((name) => edible.has(name)))
      add('eat', 'Eat available food now to restore hunger and allow healing.')
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
      if (!n('stone_pickaxe'))
        add('craft_stone_pickaxe', 'Upgrade to a durable stone pickaxe.')
      if (!n('stone_axe'))
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
    if (n((name) => name.endsWith('_sapling')))
      add('plant_tree', 'Replant a sapling on nearby grass or dirt.')
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
      const nearVillage = V.distance_from_flag <= 32 &&
        Math.abs(bot.entity.position.y - villageCtx.flag.y) <= 8
      const vo = {}
      const vadd = (key, description) => {
        if ((state.cooldowns[key] ?? 0) < Date.now()) vo[key] = description
      }
      const materials = buildMaterialCount(Boolean(obs.resources.workbench))
      if (nearVillage && V.blast_holes > 0 && n((name) => ['dirt', 'cobblestone', 'stone'].includes(name)) > 0)
        vadd('repair_blast_hole', 'Fill one shallow, dry blast hole in the village floor from the bottom up.')
      if (nearVillage && materials >= 2 && !V.wall?.complete)
        vadd(
          'build_wall',
          'Place two blocks of the perimeter wall that protects the Server.',
        )
      if (nearVillage && materials >= 2 && !V.gate?.complete)
        vadd(
          'build_gate',
          'Raise the front gate pillars and lintel on the south road.',
        )
      if (nearVillage && materials >= 2 && !V.my_home?.complete)
        vadd('build_home', 'Place two blocks of your own house on your lot.')
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
          nearbyBlock((b) => b.name === 'short_grass', 24))
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
        !n((name) => name.endsWith('_sword'))
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
      if (!hasBucket && !V.atCapacity) {
        if (n('iron_ingot') >= 3 && obs.resources.workbench)
          vadd(
            'craft_bucket',
            'Craft a bucket from three iron ingots to carry coolant.',
          )
        if (n('raw_iron') >= 1 && furnaceNearby())
          vadd('smelt_iron', 'Smelt raw iron in the furnace toward a bucket.')
        if (ironPick && oreNearby() && n('raw_iron') + n('iron_ingot') < 6)
          vadd(
            'mine_iron_ore',
            'Mine one iron ore with your stone pickaxe; raw iron smelts into buckets.',
          )
      }
      if (nearVillage && !V.atCapacity) {
        if (n('water_bucket') === 0 && n('bucket') > 0)
          vadd(
            'scoop_water',
            'Fill your bucket at the coolant spring south of the front gate.',
          )
        if (n('water_bucket') > 0)
          vadd(
            'feed_server',
            `Feed the Server one bucket of coolant; it boots a new villager at ${V.water?.target ?? '?'} buckets (now ${V.water?.fed ?? 0}).`,
          )
      }
      if (nearVillage && (state.role ?? null) === 'guard')
        vadd('patrol', 'Walk the perimeter on watch for creepers and guests.')
      if (!nearVillage)
        vadd('return_to_post', 'Head back toward the Server and the village.')
      const preferred = {
        guard: ['repair_blast_hole', 'patrol', 'attack_threat', 'build_gate', 'build_wall', 'reinforce_wall', 'place_torch', 'return_to_post'],
        builder: ['repair_blast_hole', 'build_wall', 'build_gate', 'build_home', 'reinforce_wall', 'expand_home', 'pave_road', 'craft_stone_shovel', 'place_torch', 'return_to_post'],
        smith: ['craft_stone_sword', 'craft_torch', 'craft_bucket', 'smelt_iron', 'mine_iron_ore', 'return_to_post'],
        coolant: ['scoop_water', 'feed_server', 'craft_bucket', 'mine_iron_ore', 'smelt_iron', 'return_to_post'],
        farmer: ['harvest_wheat', 'plant_wheat', 'till_farm', 'craft_stone_hoe', 'gather_wheat_seeds', 'craft_bread', 'hunt_food', 'plant_tree', 'return_to_post'],
      }[state.role ?? ''] ?? ['build_wall', 'build_home', 'reinforce_wall', 'expand_home', 'feed_server', 'scoop_water']
      const ordered = {}
      const toolPrerequisites = !n(isPick) || !obs.resources.workbench || state.plan.goal === 'equip_tools'
      if (toolPrerequisites) {
        for (const key of ['place_table', 'craft_table', 'craft_wooden_pickaxe', 'craft_stone_pickaxe',
          'craft_stone_axe', 'craft_sticks', 'craft_planks'])
          if (options[key]) ordered[key] = options[key]
      }
      for (const key of preferred) if (vo[key]) ordered[key] = vo[key]
      for (const [key, description] of Object.entries(vo))
        if (!ordered[key]) ordered[key] = description
      const merged = { ...ordered, ...options }
      if (!Object.keys(merged).length)
        merged.explore =
          'Try a different scouting direction after the blocked route.'
      return merged
    }
    if (!Object.keys(options).length)
      options.explore =
        'Try a different scouting direction after the blocked route.'
    return options
  }
  async function execute(action) {
    const items = bot.inventory.items()
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
      const b = nearbyBlock((b) => isLog(b.name), 24)
      if (!b) throw Error('No reachable tree')
      return dig(b, '_axe')
    }
    if (action === 'mine_stone') {
      const b = nearbyBlock((b) => stoneNames.has(b.name), 12)
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
      const p = openGround(bot.entity.position, 7).find((p) =>
        ['grass_block', 'dirt'].includes(bot.blockAt(p.offset(0, -1, 0))?.name),
      )
      if (!p) throw Error('No suitable soil')
      return place(p, sapling)
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
      await walk(
        new goals.GoalNear(
          drop.position.x,
          drop.position.y,
          drop.position.z,
          1,
        ),
        7000,
      )
      await sleep(650)
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
      const landmark = nearbyBlock((b) => isLog(b.name), 64)
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
      if (action === 'repair_blast_hole') return repairBlastHole()
      if (action === 'till_farm') return tendFarm()
      if (action === 'plant_wheat') return sowWheat()
      if (action === 'harvest_wheat') return harvestWheat()
      if (action === 'pave_road') return paveRoad()
      if (action === 'gather_wheat_seeds') {
        const grass = nearbyBlock((b) => b.name === 'short_grass', 24)
        if (!grass) throw new Error('No nearby wild grass for seeds')
        const result = await dig(grass)
        return { cutGrass: grass.position, collected: result.collected }
      }
      if (action === 'build_wall') {
        const result = await buildFrom(layout.wall)
        return { ...result, structure: 'wall' }
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
        const result = await buildFrom(layout.home)
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
      if (action === 'patrol') return patrolOnce()
      if (action === 'return_to_post') {
        return approach(layout.flag, 6)
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
        ...(villageCtx
          ? ['build_wall', 'build_gate', 'build_home', 'reinforce_wall',
              'expand_home', 'repair_blast_hole', 'till_farm', 'plant_wheat',
              'harvest_wheat', 'gather_wheat_seeds', 'pave_road',
              'craft_stone_hoe', 'craft_stone_shovel', 'craft_bread', 'place_torch',
              'craft_stone_sword', 'craft_torch', 'craft_bucket', 'mine_iron_ore',
              'smelt_iron', 'scoop_water', 'feed_server', 'patrol',
              'return_to_post', 'attack_threat']
          : ['build_shelter', 'relocate_shelter']),
      ],
      navigation: {
        observations: 'loaded local blocks and entities; darkness does not hide them',
        max_drop_blocks: 2,
        pillar_climbing: false,
        recovery: 'short alternate routes; safe terrain clearing; preserve construction',
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
