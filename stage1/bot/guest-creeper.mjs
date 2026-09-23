// Scripted audience clankers: real vanilla creeper entities, steered by the
// match controller through collision-aware paths. No player account or camera
// slot is consumed. The observer supplies loaded blocks and server packets;
// only the tagged mob's motion is changed, never arena construction.
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import pathfinder from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { confirmGuestExplosion } from './guest-boom.mjs'

export function creeperSummon(uuid, nickname, p) {
  if (!/^[a-f0-9-]{36}$/.test(uuid) || !/^[A-Za-z0-9_]{2,14}$/.test(nickname) ||
      ![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('Invalid creeper spawn')
  const hex = uuid.replaceAll('-', '')
  const ints = [0, 8, 16, 24].map((i) => Number.parseInt(hex.slice(i, i + 8), 16) | 0)
  // Keep vanilla physics enabled. NoAI also disables motion integration in
  // vanilla; zero walking speed/range suppresses wandering and auto-targets
  // while the controller supplies velocity and decides when to ignite.
  return `summon minecraft:creeper ${p.x} ${p.y} ${p.z} {UUID:[I;${ints.join(',')}],Tags:["cp_auto_creeper"],CustomName:'{"text":"${nickname}"}',CustomNameVisible:1b,PersistenceRequired:1b,Attributes:[{Name:"minecraft:generic.movement_speed",Base:0d},{Name:"minecraft:generic.follow_range",Base:0d}],Fuse:20s,ExplosionRadius:3b}`
}

// Native mobs retain momentum between controller ticks. Cardinal waypoints
// leave room to clear a wall corner before turning toward the next cell.
class CreeperMovements extends pathfinder.Movements {
  getMoveDiagonal() {}
}

export class NativeCreeperDirector {
  constructor({ observer, send, sendOnce = send, onBoom = () => {}, onEnd = () => {}, log = () => {} }) {
    this.observer = observer
    this.send = send
    this.sendOnce = sendOnce
    this.onBoom = onBoom
    this.onEnd = onEnd
    this.log = log
    this.active = null
    this.busy = false
    observer.loadPlugin(pathfinder.pathfinder)
    this.movements = new CreeperMovements(observer)
    Object.assign(this.movements, { canDig: false, allow1by1towers: false,
      allowParkour: false, allowSprinting: false, allowEntityDetection: false,
      canOpenDoors: false, maxDropDown: 2, infiniteLiquidDropdownDistance: false })
    this.movements.scafoldingBlocks = []
    observer.pathfinder.setMovements(this.movements)
    this.timer = setInterval(() => {
      if (this.busy || !this.active) return
      this.busy = true
      const token = this.active.entry.token
      this.tick().catch((e) => {
        this.log('auto_creeper_error', { error: String(e) })
        return this.stop('failed', token)
      }).finally(() => { this.busy = false })
    }, 200)
  }

  entity(a = this.active) {
    return a && Object.values(this.observer.entities).find((e) => e.uuid === a.uuid)
  }

  position() {
    const p = this.entity()?.position
    return p && { x: p.x, y: p.y, z: p.z }
  }

  async spawn(entry, anatomy) {
    if (this.active) throw new Error('A native creeper is already active')
    const a = { entry, uuid: randomUUID(), target: new Vec3(anatomy.base.x + .5,
      anatomy.base.y + 1, anatomy.base.z + .5), path: [], replanAt: 0,
      startedAt: Date.now(), lastMovedAt: Date.now(), igniting: false, ready: false }
    this.active = a
    const p = anatomy.guestSpawn
    // Exactly one summon attempt; a lost acknowledgement never spawns a twin.
    await this.sendOnce(creeperSummon(a.uuid, entry.nickname, { x: p.x + .5, y: p.y, z: p.z + .5 }))
    for (let i = 0; i < 30 && this.active === a && !this.entity(a); i++) await sleep(100)
    if (this.active !== a) {
      await this.send(`kill ${a.uuid}`)
      return false
    }
    if (!this.entity(a)) { await this.stop('spawn-failed'); return false }
    a.ready = true
    this.log('auto_creeper_spawned', { nickname: entry.nickname, uuid: a.uuid, position: this.position() })
    return true
  }

  replan(a, p) {
    const generator = this.observer.pathfinder.getPathFromTo(this.movements, p,
      new pathfinder.goals.GoalNear(a.target.x, a.target.y, a.target.z, 2),
      { optimizePath: false, timeout: 120, tickTimeout: 25, searchRadius: 40 })
    // One bounded search slice per tick keeps the guest gateway responsive.
    const result = generator.next().value?.result
    a.path = result?.path || []
    a.pathStatus = result?.status
    a.replanAt = Date.now() + 1500
    if (Date.now() - a.lastMovedAt > 2500) this.log('auto_creeper_replan', {
      position: { x: p.x, y: p.y, z: p.z }, status: a.pathStatus,
      next: a.path.slice(0, 2).map(({ x, y, z }) => ({ x, y, z })),
    })
  }

  async tick() {
    const a = this.active
    if (!a?.ready || a.igniting) return
    const entity = this.entity(a)
    if (!entity) { await this.stop('died'); return }
    const p = entity.position
    if (!a.lastPosition || p.distanceTo(a.lastPosition) > .3) {
      a.lastPosition = p.clone()
      a.lastMovedAt = Date.now()
    }
    const distance = Math.hypot(p.x - a.target.x, p.z - a.target.z)
    if ((distance <= 2.5 && Math.abs(p.y - a.target.y) < 2) || Date.now() - a.lastMovedAt > 6000) {
      await this.ignite(a, p)
      return
    }
    if (!a.path.length || (Date.now() >= a.replanAt && Date.now() - a.lastMovedAt > 2500)) this.replan(a, p)
    while (a.path.length && Math.hypot(a.path[0].x + .5 - p.x, a.path[0].z + .5 - p.z) < .13 &&
      Math.abs(a.path[0].y - p.y) < .6) a.path.shift()
    const next = a.path[0]
    if (!next) return
    const dx = next.x + .5 - p.x, dz = next.z + .5 - p.z
    const length = Math.hypot(dx, dz)
    if (length < .05) return
    const speed = Math.min(.28, length * .45)
    // Preserve vertical velocity/gravity. Native server collision resolves
    // every impulse; no teleport-through-walls shortcut is used.
    for (const command of [
      `data modify entity ${a.uuid} Motion[0] set value ${(dx / length * speed).toFixed(4)}d`,
      `data modify entity ${a.uuid} Motion[2] set value ${(dz / length * speed).toFixed(4)}d`,
      `data merge entity ${a.uuid} {Rotation:[${(Math.atan2(-dx, dz) * 180 / Math.PI).toFixed(2)}f,0f]}`,
      ...(next.y > p.y + .5 && entity.onGround
        ? [`data modify entity ${a.uuid} Motion[1] set value 0.42d`] : []),
    ]) {
      if (this.active !== a) return
      await this.send(command)
    }
  }

  async ignite(a, position) {
    if (this.active !== a || a.igniting) return
    a.igniting = true
    const confirmed = await confirmGuestExplosion({ client: this.observer._client,
      position, summon: () => this.active === a
        ? this.sendOnce(`data merge entity ${a.uuid} {Motion:[0d,0d,0d],ignited:1b}`)
        : null })
    if (this.active !== a) return
    if (confirmed) {
      this.log('auto_creeper_boom', { nickname: a.entry.nickname, position: confirmed })
      this.onBoom(a.entry, confirmed)
    }
    await this.stop(confirmed ? 'boom' : 'unconfirmed')
  }

  async stop(reason = 'left', token = null) {
    const a = this.active
    if (!a || (token && a.entry.token !== token)) return
    this.active = null
    // UUID-scoped cleanup cannot remove a later guest or an ordinary mob.
    await this.send(`kill ${a.uuid}`)
    this.onEnd(a.entry, reason)
  }

  async close() {
    clearInterval(this.timer)
    await this.stop('shutdown')
  }
}
