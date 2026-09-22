import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { setTimeout as sleep } from 'node:timers/promises'
import { craftConfirmed } from './crafting.mjs'

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
  // Perimeter before the middle so every roof block has an adjacent support.
  for (const [x, z] of [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
    [0, -1],
    [0, 0],
  ])
    blocks.push(new Vec3(origin.x + x, origin.y + 2, origin.z + z))
  return blocks
}

export function installSurvival(bot, state, log) {
  bot.loadPlugin(pathfinder)
  const blocked = new Map()
  let scoutStep = 0
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
  function emergency() {
    if (!bot.entity || bot.health <= 0) return null
    if (threats().some((e) => e.position.distanceTo(bot.entity.position) < 9))
      return 'flee'
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
    if (bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5)) < 1.1) {
      await walk(
        new goals.GoalNear(position.x + 3, position.y, position.z - 2, 1),
      )
    }
    const faces = [
      new Vec3(0, 1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, -1, 0),
    ]
    const face = faces.find((f) => solid(bot.blockAt(position.minus(f))))
    if (!face) throw new Error('No adjacent support for placement')
    const reference = bot.blockAt(position.minus(face))
    await reach(reference)
    await bot.equip(item, 'hand')
    const crouch = ['crafting_table', 'furnace', 'chest'].includes(
      reference.name,
    )
    bot.setControlState('sneak', crouch)
    try {
      await bounded(() => bot.placeBlock(reference, face), 7000)
    } finally {
      bot.setControlState('sneak', false)
    }
    return { placed: item.name, position }
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
            !e.username.startsWith('Cam') &&
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
