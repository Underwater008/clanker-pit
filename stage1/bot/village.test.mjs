import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import {
  wallBlueprint,
  wallReinforcementBlueprint,
  gateBlueprint,
  torchSpots,
  homeLot,
  homeBlueprint,
  homeExtensionBlueprint,
  serverAnatomy,
  patrolNodes,
  farmPlots,
  roadSpots,
  blastHoleTargets,
  rotateXZ,
  blueprintProgress,
  createVillageState,
  readVillageFixture,
  WALL_RADIUS,
  WALL_HEIGHT,
  GATE_HALF_WIDTH,
  HOME_LOTS,
  ROLES,
  ROLE_LABELS,
} from './village.mjs'

const flag = new Vec3(100, 64, -200)
const key = (p) => `${p.x},${p.y},${p.z}`

test('farm and paths fit the graded village and avoid fixtures', () => {
  const plots = farmPlots(flag), roads = roadSpots(flag), a = serverAnatomy(flag)
  assert.equal(plots.length, 8)
  assert.equal(roads.length, 16)
  assert.equal(new Set([...plots, ...roads].map(key)).size, 24)
  const fixtures = new Set([flag, ...a.spring, a.basinFloor].map(key))
  const occupied = new Set(HOME_LOTS.flatMap((_, i) => [
    ...homeBlueprint(homeLot(flag, i), flag), ...homeExtensionBlueprint(flag, i),
  ]).filter((p) => p.y === flag.y + 1).map((p) => `${p.x},${p.z}`))
  for (const p of [...plots, ...roads]) {
    assert.ok(!fixtures.has(key(p)))
    assert.ok(!occupied.has(`${p.x},${p.z}`), `route or plot under home at ${p}`)
    assert.ok(p.z <= flag.z + WALL_RADIUS + 6)
    if (p.z > flag.z + WALL_RADIUS) assert.ok(Math.abs(p.x - flag.x) <= 2)
  }
  for (const p of plots)
    assert.ok(a.spring.some((s) => Math.max(Math.abs(s.x - p.x), Math.abs(s.z - p.z)) <= 4),
      `plot ${p} needs coolant-spring irrigation`)
})

test('blast repair finds shallow dry openings and leaves deep caves and fixtures alone', () => {
  const holes = new Set([
    key(flag.offset(0, 0, 4)), key(flag.offset(0, -1, 4)),
    key(flag.offset(0, 0, 5)), key(flag.offset(0, -1, 5)),
    key(flag.offset(0, -2, 5)), key(flag.offset(2, 0, 12)),
    key(flag.offset(0, 0, 6)), key(flag.offset(0, -1, 6)),
    key(flag.offset(0, -2, 6)), key(flag.offset(0, -3, 6)),
    key(flag.offset(0, -4, 6)),
  ])
  const water = new Set(serverAnatomy(flag).spring.map(key))
  const blockAt = (p) => ({
    name: water.has(key(p)) ? 'water' : holes.has(key(p)) ? 'air' : p.y > flag.y ? 'air' : 'dirt',
    boundingBox: p.y > flag.y || holes.has(key(p)) || water.has(key(p)) ? 'empty' : 'block',
  })
  const targets = blastHoleTargets(flag, blockAt).map(key)
  assert.ok(targets.includes(key(flag.offset(0, -1, 4))))
  assert.ok(targets.includes(key(flag.offset(0, -2, 5))))
  assert.ok(targets.includes(key(flag.offset(2, 0, 12)))) // farm soil can be repaired
  assert.ok(!targets.includes(key(flag.offset(0, -4, 6)))) // too deep
  assert.ok(!targets.some((p) => water.has(p)))
})

test('wall ring stands on the ground, has no duplicates, and leaves a gate gap', () => {
  const wall = wallBlueprint(flag)
  const keys = wall.map(key)
  assert.equal(new Set(keys).size, wall.length)
  // 17x17 square perimeter minus a 3-wide gate, two blocks high.
  const perimeter = 4 * (2 * WALL_RADIUS)
  assert.equal(wall.length, (perimeter - (2 * GATE_HALF_WIDTH + 1)) * WALL_HEIGHT)
  const ringColumns = new Set(wall.map((p) => `${p.x},${p.z}`))
  assert.equal(ringColumns.size, perimeter - (2 * GATE_HALF_WIDTH + 1))
  // The gate gap stays open at both heights: nothing at z=+R for |x|<=1.
  for (const p of wall)
    if (p.z === flag.z + WALL_RADIUS)
      assert.ok(Math.abs(p.x - flag.x) > GATE_HALF_WIDTH, `gate blocked at ${p}`)
  // Every column is exactly WALL_HEIGHT tall, standing ABOVE the ground
  // layer (the grass floor itself must never count as wall).
  const byColumn = {}
  const heights = new Set()
  for (const p of wall) {
    byColumn[`${p.x},${p.z}`] = (byColumn[`${p.x},${p.z}`] ?? 0) + 1
    heights.add(p.y - flag.y)
  }
  assert.ok(Object.values(byColumn).every((n) => n === WALL_HEIGHT))
  assert.ok(!heights.has(0), 'wall must not replace the ground layer')
  assert.deepEqual([...heights].sort((a, b) => a - b), [1, 2])
})

test('front gate is two pillars and a lintel over the open passage', () => {
  const gate = gateBlueprint(flag)
  const keys = gate.map(key)
  assert.equal(new Set(keys).size, gate.length)
  const pillarX = GATE_HALF_WIDTH + 1
  // 2 pillars x 2 high + 5 lintel blocks, all reachable without scaffolding.
  assert.equal(gate.length, 2 * WALL_HEIGHT + 2 * pillarX + 1)
  assert.equal(Math.max(...gate.map((p) => p.y - flag.y)), 3)
  for (let x = -pillarX; x <= pillarX; x++)
    assert.ok(keys.includes(key(flag.offset(x, 3, WALL_RADIUS))), `lintel missing above column ${x}`)
  // The passage (x in [-1,1], z=+R, above the ground) is not blocked.
  for (let x = -GATE_HALF_WIDTH; x <= GATE_HALF_WIDTH; x++)
    for (let h = 1; h <= WALL_HEIGHT; h++)
      assert.ok(!keys.includes(key(flag.offset(x, h, WALL_RADIUS))))
  // The gate also never replaces the ground layer.
  assert.ok(gate.every((p) => p.y > flag.y))
})

test('the finite wall upgrade uses graded ground without sealing homes or the gate road', () => {
  const inner = new Set(wallBlueprint(flag).map(key))
  const reinforcement = wallReinforcementBlueprint(flag)
  assert.equal(new Set(reinforcement.map(key)).size, reinforcement.length)
  assert.ok(reinforcement.length > 0)
  assert.ok(reinforcement.every((p) => !inner.has(key(p))))
  assert.ok(reinforcement.every((p) => Math.max(Math.abs(p.x - flag.x), Math.abs(p.z - flag.z)) === WALL_RADIUS - 1))
  const homes = new Set(HOME_LOTS.flatMap((_, i) => [
    ...homeBlueprint(homeLot(flag, i), flag), ...homeExtensionBlueprint(flag, i),
  ]).map(key))
  assert.ok(reinforcement.every((p) => !homes.has(key(p))), 'reinforcement must preserve all homes')
  for (const p of reinforcement)
    if (p.z === flag.z + WALL_RADIUS - 1)
      assert.ok(Math.abs(p.x - flag.x) > GATE_HALF_WIDTH, `inner gate blocked at ${p}`)
  assert.ok(!reinforcement.some((p) =>
    p.x === flag.x + WALL_RADIUS - 1 && p.z === flag.z + WALL_RADIUS - 1),
  'south-east service pocket stays open for placement access')
})

test('torch spots sit on reachable wall tops including beside the gate, without duplicates', () => {
  const spots = torchSpots(flag)
  const keys = spots.map(key)
  assert.equal(new Set(keys).size, spots.length)
  assert.ok(spots.length >= 8, `expected a lit perimeter, got ${spots.length}`)
  const wall = new Set(wallBlueprint(flag).map(key))
  const gate = new Set(gateBlueprint(flag).map(key))
  for (const p of spots) {
    const onWallTop =
      p.y === flag.y + WALL_HEIGHT + 1 && wall.has(key(p.offset(0, -1, 0)))
    assert.ok(onWallTop, `torch at ${p} needs a reachable wall top`)
    assert.equal(p.y - flag.y, 3, 'torches must remain within ground placement reach')
    assert.ok(!wall.has(key(p)) && !gate.has(key(p)), `torch collides with a block at ${p}`)
  }
  for (const side of [-1, 1])
    assert.ok(keys.includes(key(flag.offset(side * (GATE_HALF_WIDTH + 2), 3, WALL_RADIUS))), 'gate lighting needs a torch on each adjacent wall')
})

test('home lots stay inside the wall, away from the south road, and never overlap', () => {
  assert.ok(HOME_LOTS.length >= 8, 'enough lots for the population cap')
  for (const [dx, dz] of HOME_LOTS) {
    assert.ok(Math.abs(dx) <= WALL_RADIUS - 2 && Math.abs(dz) <= WALL_RADIUS - 2)
    if (dz > 0) assert.ok(Math.abs(dx) >= 3, `lot ${dx},${dz} crowds the gate road`)
  }
  assert.deepEqual(homeLot(flag, 0), flag.offset(6, 0, 0))
  for (let i = 0; i < HOME_LOTS.length; i++)
    for (let j = i + 1; j < HOME_LOTS.length; j++) {
      const [ax, az] = HOME_LOTS[i]
      const [bx, bz] = HOME_LOTS[j]
      const distance = Math.hypot(ax - bx, az - bz)
      assert.ok(
        distance >= 3,
        `lots ${i} and ${j} overlap (${distance.toFixed(1)} apart)`,
      )
    }
})

test('every home doorway faces the Server', () => {
  const flagAtOrigin = new Vec3(0, 64, 0)
  for (let i = 0; i < HOME_LOTS.length; i++) {
    const lot = homeLot(flagAtOrigin, i)
    const home = homeBlueprint(lot, flagAtOrigin)
    assert.equal(home.length, 23, `lot ${i} blueprint size`)
    const keys = new Set(home.map(key))
    assert.ok(
      home.every((p) => p.y > lot.y),
      'homes must stand above the ground layer',
    )
    // The 3x3 ring at floor level minus the doorway blocks.
    const ring = []
    for (let x = -1; x <= 1; x++)
      for (let z = -1; z <= 1; z++) {
        if (Math.abs(x) !== 1 && Math.abs(z) !== 1) continue
        ring.push([x, z])
      }
    const open = ring.filter(([x, z]) => !keys.has(key(lot.offset(x, 1, z))))
    assert.equal(open.length, 1, `lot ${i} has ${open.length} doorways`)
    const [ox, oz] = open[0]
    const towardFlag = flagAtOrigin.minus(lot)
    const dot = ox * towardFlag.x + oz * towardFlag.z
    assert.ok(dot > 0, `lot ${i} door faces away from the Server`)
    // The doorway is two blocks tall.
    assert.ok(!keys.has(key(lot.offset(ox, 2, oz))), `lot ${i} door is blocked above`)
  }
})

test('planned home extensions join the doorway and never consume another lot or fixture', () => {
  const fixed = new Set([
    ...wallBlueprint(flag), ...gateBlueprint(flag),
    ...Object.values(serverAnatomy(flag)).flat().filter((p) => p instanceof Vec3),
    ...HOME_LOTS.flatMap((_, i) => homeBlueprint(homeLot(flag, i), flag)),
  ].map(key))
  const occupied = new Set(fixed)
  for (let i = 0; i < HOME_LOTS.length; i++) {
    const extension = homeExtensionBlueprint(flag, i)
    assert.ok(extension.length <= 14, 'each home has at most two extra rooms of depth')
    for (const p of extension) {
      assert.ok(!occupied.has(key(p)), `lot ${i} overlaps protected village position ${p}`)
      occupied.add(key(p))
    }
    if (i < 4) assert.ok(extension.length > 0, `founding home ${i} can grow`)
  }
  // The two-block original entrance stays open and every extension has an
  // uncovered entrance in its outer wall.
  const lot = homeLot(flag, 1)
  const extension = new Set(homeExtensionBlueprint(flag, 1).map(key))
  assert.ok(!extension.has(key(lot.offset(0, 1, 3))))
  assert.ok(!extension.has(key(lot.offset(0, 2, 3))))
})

test('rotateXZ turns clockwise seen from above', () => {
  assert.deepEqual(rotateXZ(0, -1, 1), [-1, 0])
  assert.deepEqual(rotateXZ(0, -1, 2), [0, 1])
  assert.deepEqual(rotateXZ(0, -1, 3), [1, 0])
  assert.deepEqual(rotateXZ(2, -3, 4), [2, -3])
})

test('server anatomy: basin is contained, spring is a 2x2 south of the gate', () => {
  const a = serverAnatomy(flag)
  assert.equal(a.core.length, 2)
  assert.deepEqual(a.lantern, flag.offset(0, 3, 0))
  // The basin hole is fully surrounded by rim + the rack column.
  const rim = new Set(a.basinRim.map(key))
  for (const [dx, dz] of [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ]) {
    const neighbor = a.basinHole.offset(dx, 0, dz)
    const held =
      rim.has(key(neighbor)) ||
      (neighbor.x === a.core[0].x && neighbor.z === a.core[0].z)
    assert.ok(held, `basin leaks toward ${dx},${dz}`)
  }
  assert.equal(a.spring.length, 4)
  for (const cell of a.spring) {
    assert.ok(cell.z > flag.z + WALL_RADIUS, 'spring must sit outside the wall')
    assert.ok(cell.distanceTo(a.guestSpawn) < 12, 'spring near the gate road')
  }
  assert.deepEqual(a.guestSpawn, flag.offset(0, 1, WALL_RADIUS + 2))
  assert.ok(patrolNodes(flag).length >= 4)
})

test('blueprint progress counts only solid positions', () => {
  const positions = [new Vec3(0, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 2, 0)]
  const all = blueprintProgress(positions, () => true)
  assert.deepEqual(all, { done: 3, total: 3, complete: true })
  const half = blueprintProgress(positions, (p) => p.y < 1)
  assert.deepEqual(half, { done: 1, total: 3, complete: false })
})

test('coolant economy: feeds count, booms overheat, booting resets the meter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-'))
  const village = createVillageState({ path: join(dir, 'village.json') })
  village.adopt({ flag: { x: 0, y: 64, z: 0 }, population: ['A', 'B', 'C', 'D'] })
  village.raw.waterTarget = 3
  for (let i = 0; i < 3; i++) {
    const r = village.feedCoolant('A')
    assert.equal(r.after, i + 1)
  }
  assert.equal(village.bootVillager(), 'Ember')
  assert.equal(village.raw.waterFed, 0, 'booting a villager drains the meter')
  assert.deepEqual(village.raw.population, ['A', 'B', 'C', 'D', 'Ember'])
  // An explosion near the core costs coolant, but never below zero.
  village.feedCoolant('B')
  village.feedCoolant('B')
  const boom = village.overheat()
  assert.ok(boom.after < boom.before)
  village.overheat()
  village.overheat()
  village.overheat()
  assert.equal(village.raw.waterFed, 0)
  // At capacity, no more villagers boot even with a full meter.
  village.adopt({ population: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] })
  for (let i = 0; i < village.raw.waterTarget; i++) village.feedCoolant('A')
  assert.equal(village.bootVillager(), null)
  assert.equal(village.raw.waterFed, village.raw.waterTarget, 'a full meter is kept at capacity')
  // Roles and homes persist through a reload.
  const roles = { A: 'guard', B: 'builder' }
  village.setRoles(roles)
  village.setHome('A', { done: 23, total: 23, complete: true })
  village.setHomeUpgrade('A', { done: 7, total: 7, complete: true })
  village.setStructures({ wallUpgrade: { done: 12, total: 40, complete: false } })
  const reloaded = createVillageState({ path: join(dir, 'village.json') })
  assert.deepEqual(reloaded.raw.roles, roles)
  assert.equal(reloaded.raw.homes.A.complete, true)
  assert.equal(reloaded.snapshot().homeUpgrades.A.complete, true)
  assert.equal(reloaded.snapshot().wallUpgrade.done, 12)
  assert.equal(reloaded.raw.waterFed, village.raw.waterTarget)
})

test('guest event ids are processed exactly once across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-'))
  const village = createVillageState({ path: join(dir, 'village.json') })
  assert.equal(village.sawGuestEvent('event:1'), true)
  assert.equal(village.sawGuestEvent('event:1'), false)
  const reloaded = createVillageState({ path: join(dir, 'village.json') })
  assert.equal(reloaded.sawGuestEvent('event:1'), false)
  assert.equal(reloaded.sawGuestEvent('event:2'), true)
})

test('village fixture reader accepts only a well-formed flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-'))
  const path = join(dir, 'village.json')
  assert.equal(readVillageFixture(path), null)
  writeFileSync(path, '{')
  assert.equal(readVillageFixture(path), null)
  writeFileSync(path, JSON.stringify({ flag: { x: 1, y: 2, z: 3 } }))
  const fixture = readVillageFixture(path)
  assert.deepEqual(fixture.flag, { x: 1, y: 2, z: 3 })
  writeFileSync(path, JSON.stringify({ flag: { x: 'NaN', y: 2, z: 3 } }))
  assert.equal(readVillageFixture(path), null)
})

test('every role is a known key with a label', () => {
  for (const role of ROLES) {
    assert.ok(typeof role === 'string' && role.length > 2)
    assert.ok(ROLE_LABELS[role].length > 10)
  }
})

test('a constrained writer never clobbers keys owned by another process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-'))
  const path = join(dir, 'village.json')
  // The fixture tool writes only its marker...
  const fixture = createVillageState({ path, ownedKeys: ['roundSetup'] })
  fixture.adopt({ flag: { x: 1, y: 2, z: 3 }, roundSetup: { grantedAt: 'now' } })
  // ...while the controller, running concurrently from a stale snapshot,
  // owns only the live fields.
  const controller = createVillageState({
    path,
    ownedKeys: ['waterFed', 'roles'],
  })
  // Another writer slips in between the controller's load and its save.
  writeFileSync(
    path,
    JSON.stringify({ ...fixture.raw, roundSetup: { grantedAt: 'later' } }),
  )
  controller.setRoles({ Cinder: 'guard' })
  const merged = createVillageState({ path, ownedKeys: null })
  assert.equal(merged.raw.roles.Cinder, 'guard', 'owned key survives the merge')
  assert.equal(
    merged.raw.roundSetup.grantedAt,
    'later',
    "another writer's key is preserved, not clobbered by a stale copy",
  )
  assert.equal(merged.raw.flag.x, 1)
})


test('a guest boom commits its penalty and event guard in the same persisted state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-boom-'))
  const path = join(dir, 'village.json')
  const village = createVillageState({ path })
  village.adopt({ waterFed: 6 })
  const result = village.overheat('event:boom-1')
  assert.ok(result.after < result.before)
  const disk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(disk.waterFed, result.after)
  assert.ok(disk.processedGuestEvents.includes('event:boom-1'))
  const restarted = createVillageState({ path })
  assert.equal(restarted.overheat('event:boom-1'), null)
  assert.equal(restarted.raw.waterFed, result.after)
  rmSync(dir, { recursive: true })
})

test('failed boom persistence rolls back the guard and penalty so a retry is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-retry-'))
  const path = join(dir, 'village.json')
  const village = createVillageState({ path })
  village.adopt({ waterFed: 6 })
  const blockedTemp = `${path}.${process.pid}.tmp`
  mkdirSync(blockedTemp)
  assert.throws(() => village.overheat('event:boom-2'), { code: 'VILLAGE_PERSIST_FAILED' })
  assert.equal(village.raw.waterFed, 6)
  assert.equal(village.raw.processedGuestEvents.includes('event:boom-2'), false)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).waterFed, 6)
  assert.equal(village.saveFailures, 1)
  rmSync(blockedTemp, { recursive: true })
  const result = village.overheat('event:boom-2')
  assert.ok(result.after < 6)
  assert.equal(village.overheat('event:boom-2'), null)
  rmSync(dir, { recursive: true })
})

test('failed durable mutations cannot report a feed, villager boot or role update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-persistence-'))
  const path = join(dir, 'village.json')
  const village = createVillageState({ path })
  village.adopt({ waterFed: 3, waterTarget: 3, population: ['Cinder'] })
  const before = structuredClone(village.raw)
  const blockedTemp = `${path}.${process.pid}.tmp`
  mkdirSync(blockedTemp)
  for (const operation of [
    () => village.feedCoolant('Cinder'),
    () => village.bootVillager(),
    () => village.nextVillager(),
    () => village.setRoles({ Cinder: 'guard' }),
    () => village.setHome('Cinder', { complete: true }),
    () => village.setStructures({ wall: { complete: true } }),
    () => village.sawGuestEvent('event:failed'),
    () => village.adopt({ waterTarget: 20 }),
  ]) {
    assert.throws(operation, { code: 'VILLAGE_PERSIST_FAILED' })
    assert.deepEqual(village.raw, before)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before)
  }
  rmSync(blockedTemp, { recursive: true })
  assert.equal(village.bootVillager(), 'Ember')
  assert.equal(village.raw.waterFed, 0)
  assert.deepEqual(village.raw.population, ['Cinder', 'Ember'])
  rmSync(dir, { recursive: true })
})
