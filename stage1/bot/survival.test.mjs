import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { MirrorCache } from './native-mirror.mjs'
import { shelterBlueprint, countItems } from './survival.mjs'
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
