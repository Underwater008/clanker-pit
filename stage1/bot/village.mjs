// Village scenario: shared layout, blueprints, and coolant economy.
//
// The Server — a small server-rack monument at the heart of the village — is
// the flag. Clankers spawn around it, raise a perimeter wall with a front
// gate, build homes on lots around it, and feed it buckets of water as
// coolant. Every WATER_TARGET buckets it "boots" one new clanker villager.
// Creeper explosions near the core make it overheat and lose coolant.
//
// This module is pure layout + economy logic (offline-testable). World
// interaction lives in survival.mjs; the controller (ambient.mjs) owns the
// shared state and turns action results into village events.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { Vec3 } from 'vec3'

export const WALL_RADIUS = Number(process.env.WALL_RADIUS ?? 8)
export const WALL_HEIGHT = Number(process.env.WALL_HEIGHT ?? 2)
export const GATE_HALF_WIDTH = Number(process.env.GATE_HALF_WIDTH ?? 1)
export const WATER_TARGET = Number(process.env.FLAG_WATER_TARGET ?? 10)
export const EXPLOSION_PENALTY = Number(process.env.FLAG_EXPLOSION_PENALTY ?? 3)
export const EXPLOSION_RADIUS = Number(process.env.FLAG_EXPLOSION_RADIUS ?? 6)
export const MAX_POPULATION = Number(process.env.MAX_POPULATION ?? 8)
export const COUNCIL_INTERVAL = Math.max(
  120000,
  Number(process.env.COUNCIL_INTERVAL_MS ?? 600000),
)

export const ROLES = ['guard', 'builder', 'smith', 'coolant', 'farmer']
export const ROLE_LABELS = {
  guard: 'Guard — patrol the wall, intercept creepers and hostile players near the Server',
  builder: 'Builder — raise and reinforce the wall, enlarge homes on safe lots, and repair blast damage',
  smith: 'Smith — keep tools, weapons, torches, and buckets in supply',
  coolant: 'Coolant Engineer — fetch water and feed the Server so it can boot villagers',
  farmer: 'Farmer — keep everyone fed; hunt, gather, and replant',
}

// Names for villagers the Server boots. Initial cast comes from BOT_NAMES.
export const VILLAGER_POOL = (
  process.env.VILLAGER_POOL ?? 'Ember,Juno,Rook,Wisp,Patch,Gadget,Sprocket,Lumen'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const v = (p) =>
  p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)
const plus = (base, dx, dy, dz) =>
  v(base).offset(Math.round(dx), Math.round(dy), Math.round(dz))

/** Rotate local coordinates around the Y axis. r=0 identity; each step is 90°
 * clockwise seen from above: (x,z) -> (z,-x). */
export function rotateXZ(x, z, r) {
  let out = [x, z]
  for (let i = 0; i < (r & 3); i++)
    out = [out[1], -out[0] + 0] // +0 normalizes -0 for strict comparisons
  return out
}

/** Wall ring: a square of radius WALL_RADIUS around the flag, two blocks
 * high, standing ON the ground (flag.y is the grass floor, so construction
 * starts one block above it), with a gate gap in the south (+Z) wall. */
export function wallBlueprint(flag) {
  const positions = []
  const R = WALL_RADIUS
  for (let x = -R; x <= R; x++)
    for (let z = -R; z <= R; z++) {
      const onRing = Math.abs(x) === R || Math.abs(z) === R
      if (!onRing) continue
      if (z === R && Math.abs(x) <= GATE_HALF_WIDTH) continue // gate gap
      for (let h = 1; h <= WALL_HEIGHT; h++)
        positions.push(plus(flag, x, h, z))
    }
  return positions
}

/** One finite inner reinforcement layer on the graded village floor. Dense
 * homes already occupy part of that strip, so they take precedence; their
 * walls act as the support there. Never block the south passage or expand
 * onto ungraded ground outside the original perimeter. */
export function wallReinforcementBlueprint(flag) {
  const positions = []
  const R = WALL_RADIUS - 1
  const f = v(flag)
  const reserved = new Set([
    ...HOME_LOTS.flatMap((_, i) => homeBlueprint(homeLot(flag, i), flag)),
    ...HOME_LOTS.flatMap((_, i) => homeExtensionBlueprint(flag, i)),
    ...Object.values(serverAnatomy(flag)).flat().filter((p) => p instanceof Vec3),
  ].map((p) => `${p.x},${p.y},${p.z}`))
  for (let x = -R; x <= R; x++)
    for (let z = -R; z <= R; z++) {
      if (Math.abs(x) !== R && Math.abs(z) !== R) continue
      if (z === R && Math.abs(x) <= GATE_HALF_WIDTH) continue
      for (let h = 1; h <= WALL_HEIGHT; h++)
        if (!reserved.has(`${f.x + x},${f.y + h},${f.z + z}`))
          positions.push(plus(flag, x, h, z))
    }
  return positions
}

/** Front gate: wall-height pillars and one lintel above a two-block passage.
 * This height stays reachable from the ground without temporary scaffolding.
 * The passage itself stays open — the clankers must guard it. */
export function gateBlueprint(flag) {
  const positions = []
  const R = WALL_RADIUS
  const pillarX = GATE_HALF_WIDTH + 1
  for (const x of [-pillarX, pillarX])
    for (let h = 1; h <= WALL_HEIGHT; h++)
      positions.push(plus(flag, x, h, R))
  for (let x = -pillarX; x <= pillarX; x++)
    positions.push(plus(flag, x, WALL_HEIGHT + 1, R))
  return positions
}

/** Torch stands along the wall top, including beside the gate. */
export function torchSpots(flag) {
  const spots = []
  const R = WALL_RADIUS
  const top = WALL_HEIGHT + 1 // one above the wall's highest block
  for (let x = -R; x <= R; x += 4) {
    if (Math.abs(x) <= GATE_HALF_WIDTH + 1) continue
    spots.push(plus(flag, x, top, R), plus(flag, x, top, -R))
  }
  for (let z = -R + 4; z <= R - 4; z += 4)
    spots.push(plus(flag, -R, top, z), plus(flag, R, top, z))
  // Adjacent wall tops are reachable from the ground; the lintel top is not.
  spots.push(
    plus(flag, -(GATE_HALF_WIDTH + 2), top, R),
    plus(flag, GATE_HALF_WIDTH + 2, top, R),
  )
  return spots
}

/** Home lots inside the wall. South stays clear: that is the gate road.
 * The first four lots are the founding cast; later villagers fill the rest.
 * Centers are at least 3 blocks apart so the 3x3 homes never interpenetrate
 * (shared walls are fine — townhouses). */
export const HOME_LOTS = [
  [6, 0],
  [0, -6],
  [-6, 0],
  [-6, 6],
  [6, -6],
  [-3, 4],
  [4, 4],
  [-6, -3],
  [6, -3],
  [-3, -6],
  [3, -6],
]
export function homeLot(flag, index) {
  const [dx, dz] = HOME_LOTS[index % HOME_LOTS.length]
  return plus(flag, dx, 0, dz)
}

/** A 3x3 home with a complete roof, doorway turned to face the Server.
 * Local shell from survival.mjs's shelter shape, rotated per lot. */
export function homeBlueprint(lot, flag) {
  const shell = [] // [x, y, z] local, doorway on -z at y0/y1 like shelterBlueprint
  for (let y = 0; y < 2; y++)
    for (let x = -1; x <= 1; x++)
      for (let z = -1; z <= 1; z++) {
        if (Math.abs(x) !== 1 && Math.abs(z) !== 1) continue
        if (x === 0 && z === -1) continue
        shell.push([x, y, z])
      }
  for (const [x, z] of [
    [-1, -1], [-1, 0], [0, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1],
  ])
    shell.push([x, 2, z])
  const center = v(lot)
  const best = homeRotation(center, flag)
  return shell.map(([x, y, z]) => {
    const [rx, rz] = rotateXZ(x, z, best)
    // Homes stand ON the ground: one block above the lot's floor level.
    return center.offset(rx, y + 1, rz)
  })
}

function homeRotation(center, flag) {
  const dx = v(flag).x - center.x
  const dz = v(flag).z - center.z
  let best = 0, bestDot = -Infinity
  for (let r = 0; r < 4; r++) {
    const [ox, oz] = rotateXZ(0, -1, r)
    const dot = ox * dx + oz * dz
    if (dot > bestDot) { bestDot = dot; best = r }
  }
  return best
}

/** Add one or two blocks of depth in front of the existing doorway. The old
 * doorway stays open and the new outer wall has its own two-block entrance.
 * Dense lots may not have a safe extension: leave those homes untouched.
 * Earlier lots get first claim on space, making the layout deterministic. */
export function homeExtensionBlueprint(flag, index) {
  if (!Number.isInteger(index) || index < 0 || index >= HOME_LOTS.length) return []
  const key = (p) => `${p.x},${p.y},${p.z}`
  const anatomy = serverAnatomy(flag)
  const reserved = new Set([
    ...wallBlueprint(flag), ...gateBlueprint(flag),
    ...Object.values(anatomy).flat().filter((p) => p instanceof Vec3),
    ...HOME_LOTS.flatMap((_, i) => homeBlueprint(homeLot(flag, i), flag)),
  ].map(key))
  for (let i = 0; i <= index; i++) {
    const lot = homeLot(flag, i)
    const rotation = homeRotation(lot, flag)
    let selected = []
    for (const depth of [2, 1]) {
      const extension = []
      for (let z = -2; z >= -(depth + 1); z--) {
        for (const x of [-1, 1])
          for (const y of [1, 2]) {
            const [rx, rz] = rotateXZ(x, z, rotation)
            extension.push(lot.offset(rx, y, rz))
          }
        for (const x of [-1, 0, 1]) {
          const [rx, rz] = rotateXZ(x, z, rotation)
          extension.push(lot.offset(rx, 3, rz))
        }
      }
      if (extension.every((p) => !reserved.has(key(p)))) {
        selected = extension
        break
      }
    }
    if (i === index) return selected
    for (const p of selected) reserved.add(key(p))
  }
  return []
}

/** The Server monument core (top lantern) and coolant basin positions. */
export function serverAnatomy(flag) {
  const f = v(flag)
  return {
    base: f,
    core: [1, 2].map((h) => f.offset(0, h, 0)), // iron blocks
    lantern: f.offset(0, 3, 0),
    // Coolant basin: a one-block basin east of the rack. Water is placed on
    // the floor block's top face and held by the rim.
    basinFloor: plus(f, 2, 0, 0),
    basinHole: plus(f, 2, 1, 0),
    basinRim: [
      [1, 0], [3, 0], [2, 1], [2, -1], [1, 1], [3, 1], [1, -1], [3, -1],
    ].map(([x, z]) => plus(f, x, 1, z)),
    // Coolant spring: a 2x2 infinite water source south of the gate.
    spring: [
      [0, 12], [1, 12], [0, 13], [1, 13],
    ].map(([x, z]) => plus(f, x, 0, z)),
    springSign: plus(f, 0, 1, 11),
    // Starter supply chest, west of the rack.
    chest: plus(f, -3, 1, 0),
    // Where guest creepers drop in: just outside the front gate.
    guestSpawn: plus(f, 0, 1, WALL_RADIUS + 2),
  }
}

export function patrolNodes(flag) {
  const R = WALL_RADIUS
  const points = [
    [R, R - 1], [R - 1, -R], [-R, -R + 1], [-R + 1, R - 1], [0, R - 1],
  ]
  return points.map(([x, z]) => plus(flag, x, 0, z))
}

/** Build progress helper: how many blueprint positions are already solid. */
export function blueprintProgress(positions, blockAt) {
  let done = 0
  for (const p of positions) if (blockAt(p)) done++
  return { done, total: positions.length, complete: done === positions.length }
}

/** Names of solid, placeable building materials the wall/homes accept. */
export const BUILD_MATERIALS = [
  'cobblestone', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'oak_log', 'spruce_log', 'birch_log', 'deepslate', 'andesite', 'diorite',
]
export function isBuildMaterial(name) {
  return BUILD_MATERIALS.includes(name)
}

/**
 * Shared, persisted village state. Normally a single writer (the controller
 * process) — but short-lived fixture tools also update a few fields, so
 * writers pass `ownedKeys` and every save MERGES: keys this process does not
 * own are re-read fresh from disk instead of being clobbered by a stale
 * in-memory copy. Writes go to a per-process temp file (no cross-process
 * rename races). Failed saves restore the last committed state and throw a
 * labeled error; callers must not announce an unpersisted game mutation.
 */
export function createVillageState({
  path,
  now = Date.now,
  ownedKeys = null,
}) {
  const defaults = () => ({
    version: 1,
    flag: null, // {x,y,z} ground block under the rack; null until set up
    waterFed: 0,
    waterTarget: WATER_TARGET,
    population: [], // all clanker names, founding cast + booted villagers
    bootedVillagers: [],
    homes: {}, // name -> {done,total,complete}
    homeUpgrades: {}, // name -> progress of the finite room extension
    wall: null, // {done,total,complete} refreshed from world observations
    wallUpgrade: null, // progress of the finite inner reinforcement layer
    gate: null,
    roles: {}, // name -> role
    lastBoomAt: 0,
    processedGuestEvents: [],
    createdAt: new Date().toISOString(),
  })
  let state
  try {
    state = { ...defaults(), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    state = defaults()
  }
  let committed = structuredClone(state)
  const saveFailures = { count: 0 }
  function save() {
    try {
      let toWrite = state
      if (ownedKeys) {
        // Merge: keep other writers' keys fresh from disk (e.g. the round
        // fixture marker written by fixture-grant while the controller runs).
        try {
          const disk = JSON.parse(readFileSync(path, 'utf8'))
          if (disk && typeof disk === 'object') {
            const merged = { ...disk }
            for (const key of ownedKeys) if (key in state) merged[key] = state[key]
            toWrite = merged
          }
        } catch {
          // Unreadable or missing: write our own view.
        }
      }
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(toWrite))
      renameSync(tmp, path)
      committed = structuredClone(state)
    } catch (cause) {
      saveFailures.count++
      state = structuredClone(committed)
      const error = new Error(`Village state persistence failed: ${cause.message}`, { cause })
      error.code = 'VILLAGE_PERSIST_FAILED'
      throw error
    }
  }
  function chatWorthy(amount) {
    const before = state.waterFed
    state.waterFed = Math.max(0, state.waterFed + amount)
    return { before, after: state.waterFed, changed: before !== state.waterFed }
  }
  return {
    get raw() {
      return state
    },
    get saveFailures() {
      return saveFailures.count
    },
    get exists() {
      return Boolean(state.flag)
    },
    flag: () => (state.flag ? v(state.flag) : null),
    anatomy: () => (state.flag ? serverAnatomy(state.flag) : null),
    save,
    snapshot: () => ({
      flag: state.flag,
      water: {
        fed: state.waterFed,
        target: state.waterTarget,
        pct: Math.min(
          100,
          Math.round((100 * state.waterFed) / Math.max(1, state.waterTarget)),
        ),
      },
      population: [...state.population],
      bootedVillagers: [...state.bootedVillagers],
      homes: state.homes,
      homeUpgrades: state.homeUpgrades,
      wall: state.wall,
      wallUpgrade: state.wallUpgrade,
      gate: state.gate,
      roles: { ...state.roles },
      atCapacity: state.population.length >= MAX_POPULATION,
    }),
    feedCoolant(botName) {
      const r = chatWorthy(1)
      state.lastFedBy = botName
      save()
      return r
    },
    /** Persist the guest event guard and its coolant penalty together. An
     * event is never acknowledged before its game effect has committed. */
    overheat(eventId = null) {
      if (eventId && state.processedGuestEvents.includes(eventId)) return null
      if (eventId) state.processedGuestEvents = [...state.processedGuestEvents, eventId].slice(-64)
      const r = chatWorthy(-EXPLOSION_PENALTY)
      state.lastBoomAt = now()
      save()
      return r
    },
    nextVillager() {
      if (state.population.length >= MAX_POPULATION) return null
      const used = new Set([...state.population, ...state.bootedVillagers])
      const name = VILLAGER_POOL.find((n) => !used.has(n))
      if (!name) return null
      state.bootedVillagers.push(name)
      state.population.push(name)
      save()
      return name
    },
    /** The Server boots a villager when the coolant target is reached; the
     * population growth and the coolant reset persist in one atomic write so
     * a crash between the two can never double-boot. */
    bootVillager() {
      if (state.waterFed < state.waterTarget) return null
      if (state.population.length >= MAX_POPULATION) return null
      const used = new Set([...state.population, ...state.bootedVillagers])
      const name = VILLAGER_POOL.find((n) => !used.has(n))
      if (!name) return null
      state.bootedVillagers.push(name)
      state.population.push(name)
      state.waterFed = 0
      save()
      return name
    },
    setRoles(roles) {
      state.roles = { ...roles }
      save()
    },
    setHome(name, progress) {
      state.homes[name] = progress
      save()
    },
    setHomeUpgrade(name, progress) {
      state.homeUpgrades[name] = progress
      save()
    },
    setStructures({ wall, gate, wallUpgrade } = {}) {
      if (wall) state.wall = wall
      if (gate) state.gate = gate
      if (wallUpgrade) state.wallUpgrade = wallUpgrade
      save()
    },
    sawGuestEvent(id) {
      if (state.processedGuestEvents.includes(id)) return false
      state.processedGuestEvents.push(id)
      state.processedGuestEvents = state.processedGuestEvents.slice(-64)
      save()
      return true
    },
    adopt(parsed) {
      state = { ...state, ...parsed }
      save()
    },
  }
}

/** Round-trip check for the fixture file so the controller never invents a
 * village position (hidden world knowledge is not allowed). */
export function readVillageFixture(path) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !parsed.flag ||
      !Number.isFinite(parsed.flag.x) ||
      !Number.isFinite(parsed.flag.y) ||
      !Number.isFinite(parsed.flag.z)
    )
      return null
    return parsed
  } catch {
    return null
  }
}
