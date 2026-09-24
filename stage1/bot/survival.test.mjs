import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { MirrorCache, replayConfigurationBeforeFinish } from './native-mirror.mjs'
import { shelterBlueprint, countItems, createFleeFailureGate, urgentFleeThreats } from './survival.mjs'
import minecraftData from 'minecraft-data'
import mc from 'minecraft-protocol'

test('shelter has a usable two-block doorway, complete roof and no duplicate blocks', () => {
  const blocks = shelterBlueprint(new Vec3(10, 64, 20)),
    keys = blocks.map((p) => p.toString())
  assert.equal(blocks.length, 23)
  assert.equal(new Set(keys).size, 23)
  assert.ok(!keys.includes(new Vec3(10, 64, 19).toString()))
  assert.ok(!keys.includes(new Vec3(10, 65, 19).toString()))
  assert.equal(blocks.filter((p) => p.y === 66).length, 9)
})
test('resource counts sum stacks, including different wood species', () => {
  assert.equal(
    countItems(
      [
        { name: 'oak_planks', count: 5 },
        { name: 'birch_planks', count: 12 },
        { name: 'stick', count: 8 },
      ],
      (n) => n.endsWith('_planks'),
    ),
    17,
  )
})

test('failed escape routes yield to planning until danger changes', () => {
  let clock = 1000
  const gate = createFleeFailureGate({ now: () => clock, retryMs: 60000 })
  const at = new Vec3(0, 64, 0)
  const drowned = { id: 7, position: new Vec3(3, 62, 0) }
  const phantom = { id: 8, position: new Vec3(4, 66, 0) }
  assert.equal(gate.recordFailure(drowned, at, at), false)
  assert.equal(gate.shouldYield([drowned], at, 0), false)
  clock += 1000
  assert.equal(gate.recordFailure(drowned, at, at), true)
  assert.equal(gate.shouldYield([drowned], at, 0), true)
  assert.equal(gate.shouldYield([drowned], at, clock + 1), false, 'new damage restores reflex')
  gate.recordFailure(drowned, at, at)
  gate.recordFailure(drowned, at, at)
  assert.equal(gate.shouldYield([drowned], at, 0), true)
  assert.equal(gate.shouldYield([{ id: 8, position: drowned.position }], at, 0), false, 'new mob restores reflex')
  gate.recordFailure(drowned, at, at, [drowned, phantom])
  gate.recordFailure(drowned, at, at, [drowned, phantom])
  assert.equal(gate.shouldYield([drowned, phantom], at, 0), true, 'already nearby mobs do not cancel the yield')
  assert.equal(gate.shouldYield([drowned, phantom, { id: 9, position: new Vec3(5, 64, 0) }], at, 0), false, 'a genuinely new mob restores reflex')
  gate.recordFailure(drowned, at, at)
  gate.recordFailure(drowned, at, at)
  assert.equal(gate.shouldYield([{ ...drowned, position: new Vec3(1, 64, 0) }], at, 0), false, 'contact restores reflex')
  gate.recordFailure(drowned, at, at)
  gate.recordFailure(drowned, at, at)
  assert.equal(gate.shouldYield([drowned], new Vec3(2, 64, 0), 0), false, 'movement restores reflex')
  gate.recordFailure(drowned, at, at)
  gate.recordFailure(drowned, at, at)
  clock += 60000
  assert.equal(gate.shouldYield([drowned], at, 0), false, 'elapsed time retries reflex')
})
test('model-directed survival interrupts for imminent contact or fresh damage', () => {
  const at = new Vec3(0, 64, 0)
  const near = { id: 1, position: new Vec3(2.5, 64, 0) }
  const distant = { id: 2, position: new Vec3(6, 64, 0) }
  assert.deepEqual(urgentFleeThreats([near, distant], at, { modelDirected: true }), [near])
  assert.deepEqual(urgentFleeThreats([near, distant], at, { modelDirected: true, critical: true }), [near, distant])
  assert.deepEqual(urgentFleeThreats([near, distant], at), [near, distant])
})
test('mirror reconnect replays current block changes and discards unloaded chunks', () => {
  const c = new MirrorCache()
  c.accept('map_chunk', { x: -2, z: 3 })
  c.accept('multi_block_change', {
    chunkCoordinates: { x: -2, y: 4, z: 3 },
    records: [7 * 4096 + (5 << 8) + (6 << 4) + 2],
  })
  assert.deepEqual(
    [...c.chunks.get('-2,3').changes.values()],
    [{ location: { x: -27, y: 66, z: 54 }, type: 7 }],
  )
  c.accept('block_change', { location: { x: -27, y: 66, z: 54 }, type: 8 })
  assert.equal(c.chunks.get('-2,3').changes.size, 1)
  c.accept('unload_chunk', { chunkX: -2, chunkZ: 3 })
  assert.equal(c.chunks.size, 0)
})
test('respawn clears old world state and player removal prevents stale players', () => {
  const c = new MirrorCache()
  c.accept('map_chunk', { x: 1, z: 2 })
  c.accept('spawn_entity', { entityId: 4 })
  c.accept('player_info', {
    action: { add_player: true },
    data: [{ uuid: 'x', player: { name: 'A' } }],
  })
  c.accept('player_info', {
    action: { add_player: false, update_latency: true },
    data: [
      {
        uuid: 'x',
        player: undefined,
        chatSession: undefined,
        gamemode: undefined,
        latency: 30,
      },
    ],
  })
  assert.equal(c.players.get('x').player.name, 'A')
  assert.equal(c.players.get('x').latency, 30)
  c.accept('player_remove', { players: ['x'] })
  assert.equal(c.players.size, 0)
  c.accept('respawn', {})
  assert.equal(c.chunks.size, 0)
  assert.equal(c.entities.size, 0)
})
test('mirror retains self air, pose and armor for late viewers without a self spawn packet', () => {
  const c = new MirrorCache()
  c.accept('login', { entityId: 42 })
  c.accept('entity_metadata', { entityId: 42, metadata: [
    { key: 1, type: 'int', value: 120 }, { key: 6, type: 'pose', value: 3 },
  ] })
  c.accept('entity_metadata', { entityId: 42, metadata: [{ key: 1, type: 'int', value: 80 }] })
  c.accept('entity_update_attributes', { entityId: 42, properties: [{ key: 'generic.armor', value: 6, modifiers: [] }] })
  c.accept('entity_update_attributes', { entityId: 42, properties: [{ key: 'generic.max_health', value: 20, modifiers: [] }] })
  assert.equal(c.selfMetadata.get(1).value, 80)
  assert.equal(c.selfMetadata.get(6).value, 3)
  assert.equal(c.selfAttributes.get('generic.armor').value, 6)
  c.accept('respawn', {})
  assert.equal(c.selfMetadata.size, 0)
  assert.equal(c.selfAttributes.size, 0)
})
test('native viewers receive fluid tags in configuration before the phase ends', () => {
  const sent = []
  const client = { write: (name, data) => sent.push([name, data]) }
  const tags = { tags: [{ tagType: 'minecraft:fluid', tags: [{ tagName: 'minecraft:water', entries: [1, 2] }] }] }
  replayConfigurationBeforeFinish(client, new Map([['feature_flags', { features: ['minecraft:vanilla'] }], ['tags', tags]]))
  client.write('registry_data', {})
  client.write('finish_configuration', {})
  client.write('login', {})
  assert.deepEqual(sent.map(([name]) => name), ['registry_data', 'feature_flags', 'tags', 'finish_configuration', 'login'])
  assert.equal(sent[2][1], tags)
})
test('pinned protocol decodes velocity as a vector consumed by current Mineflayer', () => {
  const data = minecraftData('1.21.1')
  assert.equal(
    data.protocol.play.toClient.types.packet_entity_velocity[1][1].name,
    'velocity',
  )
  const serializer = mc.createSerializer({
    state: 'play',
    isServer: true,
    version: '1.21.1',
  })
  const parser = mc.createDeserializer({
    state: 'play',
    isServer: false,
    version: '1.21.1',
  })
  const bytes = serializer.createPacketBuffer({
    name: 'entity_velocity',
    params: { entityId: 1, velocity: { x: 400, y: 1000, z: -200 } },
  })
  const packet = parser.parsePacketBuffer(bytes).data.params
  assert.deepEqual(packet.velocity, { x: 400, y: 1000, z: -200 })
})
