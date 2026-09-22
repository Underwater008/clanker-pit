// Read-only display of a Mineflayer player in the official 1.21.1 client.
// Only the bot talks to the real game server. Viewer input is never forwarded.
import mc from 'minecraft-protocol'
import itemFactory from 'prismarine-item'
import { writeFileSync, renameSync } from 'node:fs'

const VERSION = '1.21.1'
const Item = itemFactory(VERSION)
const singleton = new Set([
  'login',
  'respawn',
  'spawn_position',
  'difficulty',
  'abilities',
  'time',
  'update_time',
  'update_health',
  'experience',
  'held_item_slot',
  'update_view_distance',
  'simulation_distance',
  'declare_commands',
  'declare_recipes',
  'tags',
  'update_tags',
])
const excluded = new Set([
  'keep_alive',
  'ping',
  'kick_disconnect',
  'position',
  'bundle_delimiter',
  'chunk_batch_start',
  'chunk_batch_finished',
  'player_chat',
  'start_configuration',
  'cookie_request',
  'transfer',
  'store_cookie',
  'resource_pack_send',
  'add_resource_pack',
])
const angleByte = (radians) =>
  ((Math.round(((Math.PI - radians) * 128) / Math.PI) + 128) & 255) - 128

// Camera smoothing helpers. The bot's raw entity orientation snaps to each
// new look target within one tick, while mineflayer rate-limits the rotation
// it actually sends the server to 3 rad/s (prismarine-physics yawSpeed and
// pitchSpeed). Native views apply the same limit and interpolate the 20 Hz
// physics samples so their cameras pan like the wide camera instead of
// frame-jumping on every look() call.
export function wrapAngle(delta) {
  let d = delta % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return d
}

export function chaseAngle(current, target, maxStep) {
  const d = wrapAngle(target - current)
  return current + Math.max(-maxStep, Math.min(maxStep, d))
}

export function interpolatePositionAt(samples, at) {
  if (samples.length === 0) return null
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (s.t <= at) {
      const n = samples[i + 1]
      if (!n) return s
      const span = n.t - s.t
      const f = span > 0 ? Math.min(1, (at - s.t) / span) : 1
      return {
        x: s.x + (n.x - s.x) * f,
        y: s.y + (n.y - s.y) * f,
        z: s.z + (n.z - s.z) * f,
      }
    }
  }
  return samples[0]
}

export class MirrorCache {
  constructor() {
    this.base = new Map()
    this.players = new Map()
    this.clearWorld()
  }
  clearWorld() {
    this.chunks = new Map()
    this.entities = new Map()
    this.window = null
  }
  accept(name, data) {
    if (name === 'respawn') this.clearWorld()
    if (singleton.has(name)) this.base.set(name, data)
    if (name === 'map_chunk')
      this.chunks.set(`${data.x},${data.z}`, {
        packet: data,
        changes: new Map(),
        blockEntities: new Map(),
      })
    if (name === 'unload_chunk')
      this.chunks.delete(`${data.chunkX},${data.chunkZ}`)
    if (name === 'update_light') {
      const c = this.chunks.get(`${data.chunkX},${data.chunkZ}`)
      if (c) c.light = data
    }
    if (name === 'block_change' || name === 'tile_entity_data') {
      const p = data.location
      const c = this.chunks.get(
        `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`,
      )
      if (c)
        (name === 'block_change' ? c.changes : c.blockEntities).set(
          `${p.x},${p.y},${p.z}`,
          data,
        )
    }
    if (name === 'multi_block_change') {
      const { x, y, z } = data.chunkCoordinates
      const c = this.chunks.get(`${x},${z}`)
      if (c)
        for (const record of data.records) {
          const location = {
            x: x * 16 + ((record >> 8) & 15),
            y: y * 16 + (record & 15),
            z: z * 16 + ((record >> 4) & 15),
          }
          c.changes.set(`${location.x},${location.y},${location.z}`, {
            location,
            type: Math.floor(record / 4096),
          })
        }
    }
    if (name === 'player_info')
      for (const p of data.data) {
        const prev = this.players.get(p.uuid) ?? { uuid: p.uuid, actions: {} }
        const next = { ...prev, actions: { ...prev.actions } }
        for (const [flag, field] of Object.entries({
          add_player: 'player',
          initialize_chat: 'chatSession',
          update_game_mode: 'gamemode',
          update_listed: 'listed',
          update_latency: 'latency',
          update_display_name: 'displayName',
        })) {
          if (data.action[flag]) {
            next.actions[flag] = true
            next[field] = p[field]
          }
        }
        this.players.set(p.uuid, next)
      }
    if (name === 'player_remove')
      for (const id of data.players) this.players.delete(id)
    if (name === 'spawn_entity' || name === 'spawn_entity_experience_orb')
      this.entities.set(data.entityId, {
        name,
        spawn: data,
        metadata: new Map(),
      })
    if (name === 'entity_destroy')
      for (const id of data.entityIds) this.entities.delete(id)
    const e = this.entities.get(data.entityId)
    if (name === 'entity_metadata' && e)
      for (const m of data.metadata) e.metadata.set(m.key, m)
    if (name === 'entity_equipment' && e) e.equipment = data
    if (name === 'open_window') this.window = data
    if (name === 'close_window') this.window = null
  }
}

export function createNativeMirror({ port, name, statePath, log = () => {} }) {
  let bot,
    cache,
    viewer,
    ready = false,
    generation = 0,
    teleportId = 0
  const registryCodec = {}
  const server = mc.createServer({
    host: '127.0.0.1',
    port,
    version: VERSION,
    'online-mode': false,
    maxPlayers: 1,
    registryCodec,
    hideErrors: true,
    motd: `${name} native view`,
    beforeLogin(client) {
      if (bot) {
        client.uuid = bot._client.uuid
        client.username = bot.username
      }
    },
  })
  const publish = () => {
    if (!statePath) return
    const tmp = `${statePath}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        name,
        port,
        ready,
        generation,
        viewer: Boolean(viewer),
        updated: Date.now(),
      }),
    )
    renameSync(tmp, statePath)
  }
  function send(packet, data) {
    if (viewer?.state !== 'play') return
    try {
      viewer.writeRaw(
        viewer.serializer.createPacketBuffer({ name: packet, params: data }),
      )
    } catch (e) {
      log('mirror_packet_error', { packet, error: String(e), field: e.field })
      viewer.end('Display packet failed')
      viewer = null
    }
  }
  const TURN_SPEED = 3 // rad/s, matches prismarine-physics yawSpeed/pitchSpeed
  const CAMERA_HZ = 60
  const INTERP_DELAY_MS = 80 // one-sample lookahead over the 50 ms sample grid
  const TELEPORT_DISTANCE = 12 // blocks; larger sample gaps are real teleports
  const cameraSamples = []
  let camYaw = null,
    camPitch = null,
    camChaseAt = 0

  const finiteEntity = (e) =>
    [e.position.x, e.position.y, e.position.z, e.yaw, e.pitch].every(
      Number.isFinite,
    )

  function resetCamera() {
    cameraSamples.length = 0
    camYaw = null
    camPitch = null
  }

  function sampleCamera() {
    const e = bot?.entity
    if (!e || !finiteEntity(e)) return
    const s = cameraSamples[cameraSamples.length - 1]
    if (
      s &&
      (s.x - e.position.x) ** 2 +
        (s.y - e.position.y) ** 2 +
        (s.z - e.position.z) ** 2 >
        TELEPORT_DISTANCE ** 2
    )
      resetCamera() // real teleport: never interpolate or pan across it
    cameraSamples.push({
      t: Date.now(),
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      yaw: e.yaw,
      pitch: e.pitch,
    })
    if (cameraSamples.length > 12) cameraSamples.shift()
  }

  function cameraTick() {
    if (!ready || cameraSamples.length === 0) return
    const now = Date.now()
    const p = interpolatePositionAt(cameraSamples, now - INTERP_DELAY_MS)
    const target = cameraSamples[cameraSamples.length - 1]
    if (camYaw === null || camPitch === null) {
      camYaw = target.yaw
      camPitch = target.pitch
      camChaseAt = now
    } else {
      const dt = Math.min(0.25, Math.max(0, (now - camChaseAt) / 1000))
      camChaseAt = now
      const max = TURN_SPEED * dt
      camYaw = chaseAngle(camYaw, target.yaw, max)
      camPitch = chaseAngle(camPitch, target.pitch, max)
    }
    send('position', {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: 180 - (camYaw * 180) / Math.PI,
      pitch: (-camPitch * 180) / Math.PI,
      flags: {},
      teleportId: ++teleportId,
    })
  }

  function position() {
    const e = bot?.entity
    if (!ready || !e || !finiteEntity(e)) return
    resetCamera() // a joining viewer lands on the true state, not an interpolation
    send('position', {
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      yaw: 180 - (e.yaw * 180) / Math.PI,
      pitch: (-e.pitch * 180) / Math.PI,
      flags: {},
      teleportId: ++teleportId,
    })
  }
  function inventory() {
    if (!ready || !bot.inventory) return
    for (const w of [bot.inventory, bot.currentWindow].filter(Boolean))
      send('window_items', {
        windowId: w.id,
        stateId: 0,
        items: w.slots.map((i) => Item.toNotch(i)),
        carriedItem: Item.toNotch(w.selectedItem),
      })
    send('held_item_slot', { slot: bot.quickBarSlot })
  }
  server.on('playerJoin', (client) => {
    if (!ready || !cache?.base.has('login'))
      return client.end('Player reconnecting; viewer will retry')
    viewer?.end('New display connected')
    viewer = client
    client.on('end', () => {
      if (viewer === client) {
        viewer = null
        publish()
      }
    })
    client.on('error', (e) => log('mirror_client_error', { error: String(e) }))
    send('login', { ...cache.base.get('login'), enforcesSecureChat: false })
    for (const [n, d] of cache.base) if (n !== 'login') send(n, d)
    for (const p of cache.players.values()) {
      const { actions, ...d } = p
      send('player_info', { action: actions, data: [d] })
    }
    send('update_view_position', {
      chunkX: Math.floor(bot.entity.position.x / 16),
      chunkZ: Math.floor(bot.entity.position.z / 16),
    })
    position()
    for (const c of cache.chunks.values()) {
      send('map_chunk', c.packet)
      if (c.light) send('update_light', c.light)
      for (const d of c.changes.values()) send('block_change', d)
      for (const d of c.blockEntities.values()) send('tile_entity_data', d)
    }
    for (const [id, e] of cache.entities) {
      const current = bot.entities[id]
      if (!current || id === bot.entity.id) continue
      send(e.name, {
        ...e.spawn,
        ...current.position,
        yaw: angleByte(current.yaw),
        pitch: Math.round((-current.pitch * 128) / Math.PI),
      })
      if (e.metadata.size)
        send('entity_metadata', {
          entityId: id,
          metadata: [...e.metadata.values()],
        })
      if (e.equipment) send('entity_equipment', e.equipment)
    }
    if (cache.window) send('open_window', cache.window)
    inventory()
    position()
    publish()
    log('mirror_joined', { port, chunks: cache.chunks.size })
  })
  server.on('error', (error) =>
    log('mirror_server_error', { error: String(error) }),
  )
  const sampleTimer = setInterval(sampleCamera, 50)
  const cameraTimer = setInterval(cameraTick, Math.round(1000 / CAMERA_HZ))
  const invTimer = setInterval(inventory, 500)
  const stateTimer = setInterval(publish, 2000)
  let dig = null,
    digAt = 0
  const digTimer = setInterval(() => {
    if (!ready || !bot?.entity) return
    const target = bot.targetDigBlock
    if (target !== dig) {
      if (dig)
        send('block_break_animation', {
          entityId: bot.entity.id,
          location: dig.position,
          destroyStage: -1,
        })
      dig = target
      digAt = Date.now()
    }
    if (dig) {
      send('animation', { entityId: bot.entity.id, animation: 0 })
      send('block_break_animation', {
        entityId: bot.entity.id,
        location: dig.position,
        destroyStage: Math.min(
          9,
          Math.floor(
            (10 * (Date.now() - digAt)) / Math.max(100, bot.digTime(dig)),
          ),
        ),
      })
    }
  }, 180)
  publish()
  return {
    attach(nextBot) {
      viewer?.end('Player reconnected')
      viewer = null
      bot = nextBot
      cache = new MirrorCache()
      ready = false
      generation = Date.now()
      dig = null
      resetCamera()
      for (const key of Object.keys(registryCodec)) delete registryCodec[key]
      const thisCache = cache
      bot._client.on('packet', (data, meta) => {
        if (bot !== nextBot) return
        if (meta.state === 'configuration' && meta.name === 'registry_data')
          registryCodec[data.id] = data
        if (meta.state !== 'play' || excluded.has(meta.name)) return
        thisCache.accept(meta.name, data)
        if (meta.name === 'entity_velocity' && data.entityId === bot.entity?.id)
          return // bot physics supplies the camera position
        send(meta.name, data)
      })
      const originalWrite = bot._client.write.bind(bot._client)
      bot._client.write = (n, d) => {
        if (bot === nextBot) {
          if (n === 'held_item_slot') send(n, { slot: d.slotId })
          if (n === 'close_window') {
            thisCache.window = null
            send(n, d)
          }
          if (n === 'arm_animation' && bot.entity)
            send('animation', {
              entityId: bot.entity.id,
              animation: d.hand === 1 ? 3 : 0,
            })
        }
        return originalWrite(n, d)
      }
      bot.on('spawn', () => {
        if (bot === nextBot) {
          ready = true
          resetCamera()
          publish()
        }
      })
      bot.on('end', () => {
        if (bot === nextBot) {
          ready = false
          viewer?.end('Player offline')
          viewer = null
          publish()
        }
      })
      publish()
    },
    close() {
      for (const t of [sampleTimer, cameraTimer, invTimer, stateTimer, digTimer])
        clearInterval(t)
      viewer?.end('Display stopped')
      server.close()
    },
  }
}
