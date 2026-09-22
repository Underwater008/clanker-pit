import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import {
  wallBlueprint,
  gateBlueprint,
  torchSpots,
  homeLot,
  homeBlueprint,
  serverAnatomy,
  patrolNodes,
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

test('wall ring has no duplicates, is two blocks high, and leaves a south gate gap', () => {
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
  // Every column is exactly WALL_HEIGHT tall.
  const byColumn = {}
  for (const p of wall)
    byColumn[`${p.x},${p.z}`] = (byColumn[`${p.x},${p.z}`] ?? 0) + 1
  assert.ok(Object.values(byColumn).every((n) => n === WALL_HEIGHT))
})

test('front gate is two pillars and a lintel over the open passage', () => {
  const gate = gateBlueprint(flag)
  const keys = gate.map(key)
  assert.equal(new Set(keys).size, gate.length)
  const pillarX = GATE_HALF_WIDTH + 1
  // 2 pillars x 3 high + 5 lintel blocks
  assert.equal(gate.length, 2 * (WALL_HEIGHT + 1) + 2 * pillarX + 1)
  // The passage itself (x in [-1,1], z=+R, y<=WALL_HEIGHT) is not blocked.
  for (let x = -GATE_HALF_WIDTH; x <= GATE_HALF_WIDTH; x++)
    for (let h = 0; h < WALL_HEIGHT; h++)
      assert.ok(!keys.includes(key(flag.offset(x, h, WALL_RADIUS))))
})

test('torch spots sit on the wall top and the gate pillars, without duplicates', () => {
  const spots = torchSpots(flag)
  const keys = spots.map(key)
  assert.equal(new Set(keys).size, spots.length)
  assert.ok(spots.length >= 8, `expected a lit perimeter, got ${spots.length}`)
  for (const p of spots) {
    const onWallTop = p.y === flag.y + WALL_HEIGHT
    const onPillar =
      p.y === flag.y + WALL_HEIGHT + 1 &&
      p.z === flag.z + WALL_RADIUS &&
      Math.abs(p.x - flag.x) === GATE_HALF_WIDTH + 1
    assert.ok(onWallTop || onPillar, `torch at ${p} rests on nothing`)
  }
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
    // The 3x3 ring at ground level minus the doorway blocks.
    const ring = []
    for (let x = -1; x <= 1; x++)
      for (let z = -1; z <= 1; z++) {
        if (Math.abs(x) !== 1 && Math.abs(z) !== 1) continue
        ring.push([x, z])
      }
    const open = ring.filter(([x, z]) => !keys.has(key(lot.offset(x, 0, z))))
    assert.equal(open.length, 1, `lot ${i} has ${open.length} doorways`)
    const [ox, oz] = open[0]
    const towardFlag = flagAtOrigin.minus(lot)
    const dot = ox * towardFlag.x + oz * towardFlag.z
    assert.ok(dot > 0, `lot ${i} door faces away from the Server`)
    // The doorway is two blocks tall.
    assert.ok(!keys.has(key(lot.offset(ox, 1, oz))), `lot ${i} door is blocked above`)
  }
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
  const reloaded = createVillageState({ path: join(dir, 'village.json') })
  assert.deepEqual(reloaded.raw.roles, roles)
  assert.equal(reloaded.raw.homes.A.complete, true)
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
