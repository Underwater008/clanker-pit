import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { setTimeout as sleep } from 'node:timers/promises'
import { craftConfirmed } from './crafting.mjs'
import {
  wallBlueprint,
  gateBlueprint,
  torchSpots,
  homeBlueprint,
  homeLot,
  serverAnatomy,
  patrolNodes,
  isBuildMaterial,
} from './village.mjs'

// One furnace operation at a time across the whole cast (they share this
// process and often share the same furnace): two clankers interleaving
// put/take on one furnace window would mix their iron. Also, opening a
// furnace has no internal timeout, so it must be raced with a deadline.
let furnaceChain = Promise.resolve()

const { pathfinder, Movements, goals } = pathfinderPkg
export const GOALS = {
  build_shelter:
    'Gather wood, craft tools and a workbench, and build a small shelter at camp.',
  equip_tools:
    'Progress from wood to stone tools, then gather useful stone and coal.',
  gather_food:
    'Find edible plants or hunt food, eat when hungry, and replant useful crops.',
  improve_camp:
    'Finish the shelter, add a furnace, plant trees, and stockpile useful materials.',
  explore: 'Scout nearby terrain for new resources, remembering where camp is.',
  protect_server:
    'Keep the Server alive: feed it coolant, guard it from creepers and hostile players, and repair blast damage.',
  build_village:
    'Raise the perimeter wall, the front gate, torches, and your own home around the Server.',
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
        gate: gateBlueprint(villageCtx.flag),
        torches: torchSpots(villageCtx.flag),
        patrol: patrolNodes(villageCtx.flag),
        home: homeBlueprint(homeLot(villageCtx.flag, villageCtx.lotIndex), villageCtx.flag),
      }
    : null
  function resetMovements() {
    const moves = new Movements(bot)
    moves.canDig = true
    moves.digCost = 2 // Prefer going around; clear ordinary terrain when needed.
    moves.exclusionAreasBreak.push((block) => {
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
    const closeThreats = threats().filter(
      (e) => e.position.distanceTo(bot.entity.position) < 9,
    )
    if (villageCtx) {
      // Guards stand and fight; everyone else keeps the old flee reflex.
      if ((state.role ?? null) === 'guard' && bot.health > 8) {
        const flagThreats = threats().filter(
          (e) => e.position.distanceTo(villageCtx.flag) < 12,
        )
        if (closeThreats.length || flagThreats.length || enemyPlayers().length)
          return 'attack_threat'
      }
    }
    if (closeThreats.length) return 'flee'
    if (bot.food < 16 && bot.inventory.items().some((i) => edible.has(i.name)))
      return 'eat'
    return null
  }
  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity && emergency() === 'flee') {
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
  async function walk(goal, ms = 11000) {
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
        log('navigation_stuck', { position: bot.entity.position, goal })
        bot.pathfinder.setGoal(null)
      }
    }, 500)
    try {
      await bounded(
        () => bot.pathfinder.goto(goal),
        ms,
        () => bot.pathfinder.setGoal(null),
      )
    } finally {
      clearInterval(watchdog)
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
    }
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
  async function collect(position) {
    await sleep(650) // item spawn, pickup delay, and falling logs need server ticks
    const item = Object.values(bot.entities)
      .filter((e) => e.name === 'item' && e.position.distanceTo(position) < 5)
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
    try {
      await reach(block)
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
      await collect(block.position).catch(() => {})
      return { block: block.name, position: block.position }
    } catch (e) {
      blocked.set(block.position.toString(), Date.now() + 120000)
      throw e
    }
  }
  const table = () => nearbyBlock((b) => b.name === 'crafting_table', 24)
  async function craft(name, times = 1) {
    const item = bot.registry.itemsByName[name]
    if (!item) throw new Error(`Unknown item ${name}`)
    const bench = table()
    if (bench) await reach(bench)
    const recipe = bot.recipesFor(item.id, null, 1, bench)[0]
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
    await bot.equip(item, 'hand')
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
    return { placed: item.name, position }
  }
  // ---- village construction and coolant skills ----------------------------
  const buildMaterialCount = () =>
    countItems(bot.inventory.items(), (n) => isBuildMaterial(n))
  const firstBuildMaterial = () =>
    bot.inventory.items().find((i) => isBuildMaterial(i.name))
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
      await place(p, material)
      if (++placed === perAction) break
    }
    return { placed }
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
    // _placeBlockWithOptions needs the solid Block under the water, not a Vec3.
    const floor = bot.blockAt(water.position.offset(0, -1, 0))
    if (!solid(floor)) throw new Error('Spring has no solid bed')
    const bucket = bot.inventory.items().find((i) => i.name === 'bucket')
    if (!bucket) throw new Error('No empty bucket')
    await bot.equip(bucket, 'hand')
    // Clicking the bed's top face with an empty bucket: vanilla scoops the
    // water source above it, and the block update confirms the pickup.
    await bot._placeBlockWithOptions(floor, new Vec3(0, 1, 0), {
      forceLook: true,
      swingArm: 'right',
    })
    await sleep(300)
    if (!bot.inventory.items().some((i) => i.name === 'water_bucket'))
      throw new Error('Bucket did not fill at the spring')
    return { filledBucket: true }
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
      await walk(new goals.GoalNear(basinFloor.x, basinFloor.y, basinFloor.z, 2))
      // _placeBlockWithOptions needs the Block object, not a bare Vec3.
      const floorBlock = bot.blockAt(basinFloor)
      if (!solid(floorBlock)) throw new Error('Server basin floor is missing')
      if (bot.blockAt(basinHole)?.name === 'water')
        throw new Error('The Server is still drinking the last bucket')
      const full = bot.inventory.items().find((i) => i.name === 'water_bucket')
      if (!full) throw new Error('No water bucket to feed the Server')
      await bot.equip(full, 'hand')
      // Vanilla bucket use: clicking the floor's top face places the water
      // in the basin hole; the type change acknowledges the pour.
      await bot._placeBlockWithOptions(floorBlock, new Vec3(0, 1, 0), {
        forceLook: true,
        swingArm: 'right',
      })
      if (bot.blockAt(basinHole)?.name !== 'water')
        throw new Error('Server basin did not accept the coolant')
      // The bucket must now be empty — real consumption, verified.
      if (!bot.inventory.items().some((i) => i.name === 'bucket'))
        throw new Error('Bucket did not empty into the basin')
      return { fedCoolant: true }
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
        blocks: built,
        total: 23,
        complete: built === 23,
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
                wall: progress(layout.wall),
                gate: progress(layout.gate),
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
    if (n(isPlank) >= 2 && obs.resources.workbench && !obs.shelter.complete)
      add(
        'build_shelter',
        'Place up to two real blocks of a small shelter, keeping its doorway open.',
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
        e.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
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
      const vo = {}
      const vadd = (key, description) => {
        if ((state.cooldowns[key] ?? 0) < Date.now()) vo[key] = description
      }
      const materials = buildMaterialCount()
      if (materials >= 2 && !V.wall?.complete)
        vadd(
          'build_wall',
          'Place two blocks of the perimeter wall that protects the Server.',
        )
      if (materials >= 2 && !V.gate?.complete)
        vadd(
          'build_gate',
          'Raise the front gate pillars and lintel on the south road.',
        )
      if (materials >= 2 && !V.my_home?.complete)
        vadd('build_home', 'Place two blocks of your own house on your lot.')
      if (
        n('torch') > 0 &&
        V.torches_lit < (V.torches_total ?? 0)
      )
        vadd(
          'place_torch',
          'Place a torch on the wall to keep monsters out of the village.',
        )
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
      if (!V.atCapacity) {
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
      if ((state.role ?? null) === 'guard')
        vadd('patrol', 'Walk the perimeter on watch for creepers and guests.')
      if (V.distance_from_flag > 64)
        vadd('return_to_post', 'Head back toward the Server and the village.')
      const preferred = {
        guard: ['patrol', 'attack_threat', 'build_gate', 'build_wall', 'place_torch', 'return_to_post'],
        builder: ['build_wall', 'build_gate', 'build_home', 'place_torch', 'return_to_post'],
        smith: ['craft_stone_sword', 'craft_torch', 'craft_bucket', 'smelt_iron', 'mine_iron_ore', 'return_to_post'],
        coolant: ['scoop_water', 'feed_server', 'craft_bucket', 'mine_iron_ore', 'smelt_iron', 'return_to_post'],
        farmer: ['hunt_food', 'plant_tree', 'return_to_post'],
      }[state.role ?? ''] ?? ['build_wall', 'build_home', 'feed_server', 'scoop_water']
      const ordered = {}
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
    if (action === 'flee') {
      const threat = threats()[0]
      if (!threat) return { safe: true }
      const p = bot.entity.position
      const dx = p.x - threat.position.x,
        dz = p.z - threat.position.z
      const length = Math.hypot(dx, dz)
      const ux = length > 0.1 ? dx / length : 1,
        uz = length > 0.1 ? dz / length : 0
      await walk(
        new goals.GoalNearXZ(
          Math.floor(p.x + ux * 12),
          Math.floor(p.z + uz * 12),
          2,
        ),
        7000,
      )
      return { escaped: threat.name, position: bot.entity.position }
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
    if (action === 'build_shelter') {
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
        const plank = bot.inventory.items().find((i) => isPlank(i.name))
        if (!plank) break
        await place(p, plank)
        if (++placed === 2) break
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
            e.position.distanceTo(bot.entity.position) < 12,
        )
        .sort(
          (a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position),
        )[0]
      if (!drop) throw Error('Drop disappeared')
      await walk(
        new goals.GoalNear(
          drop.position.x,
          drop.position.y,
          drop.position.z,
          1,
        ),
        7000,
      )
      return { collectedAt: drop.position }
    }
    if (action === 'return_to_camp') {
      const p = state.camp
      await walk(new goals.GoalNear(p.x, p.y, p.z, 4))
      return { returned: true }
    }
    if (action === 'explore') {
      const p = bot.entity.position
      // Walk toward visible resources before choosing a blind scouting bearing.
      const landmark = nearbyBlock((b) => isLog(b.name), 64)
      const angle = landmark
        ? Math.atan2(landmark.position.z - p.z, landmark.position.x - p.x)
        : scoutStep * 2.39996 + (bot.username.charCodeAt(0) % 6)
      const goal = new goals.GoalNearXZ(
        Math.floor(p.x + Math.cos(angle) * 12),
        Math.floor(p.z + Math.sin(angle) * 12),
        2,
      )
      try {
        await walk(goal, 9000)
      } catch (e) {
        scoutStep++
        throw e
      }
      return { scouted: bot.entity.position }
    }
    if (villageCtx) {
      if (action === 'build_wall') {
        const result = await buildFrom(layout.wall)
        return { ...result, structure: 'wall' }
      }
      if (action === 'build_gate') {
        const result = await buildFrom(layout.gate)
        return { ...result, structure: 'gate' }
      }
      if (action === 'build_home') {
        const result = await buildFrom(layout.home)
        return { ...result, structure: 'home' }
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
        await walk(
          new goals.GoalNear(
            layout.flag.x,
            layout.flag.y,
            layout.flag.z,
            6,
          ),
        )
        return { returned: true }
      }
      if (action === 'attack_threat') return attackThreat()
    }
    throw new Error(`Unsupported action ${action}`)
  }
  return {
    observation,
    emergency,
    candidates,
    execute,
    stop() {
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
      bot.stopDigging()
    },
  }
}
