// Pure queue/turn scheduling for guest creeper turns. No I/O — the gateway
// owns the bots and HTTP; this class decides WHO plays WHEN.
//
// Rules (product): stream viewers join a queue; every GUEST_TURN_EVERY_MS
// (default 3 minutes) the queue's head becomes a creeper near the front gate,
// for at most GUEST_TURN_MAX_MS (default one cadence, so a new creeper can
// start every 3 minutes even after a full-length turn). A turn ends on boom,
// death, disconnect, idling out, or the cap. Reserved names (the clankers,
// camera accounts, villager pool) can never be used as guest nicknames —
// the server is offline-mode and a name collision would kick the real player.
// Guest tokens must come from a cryptographic source (the gateway injects
// crypto.randomUUID-derived tokens; Math.random is only a test default).

import { randomUUID } from 'node:crypto'

export const TURN_EVERY_MS = Math.max(
  30000,
  Number(process.env.GUEST_TURN_EVERY_MS ?? 180000),
)
export const TURN_MAX_MS = Math.max(
  60000,
  Number(process.env.GUEST_TURN_MAX_MS ?? 180000),
)
export const MAX_QUEUE = Math.max(1, Number(process.env.GUEST_MAX_QUEUE ?? 20))
export const INPUT_STALE_MS = Math.max(
  500,
  Number(process.env.GUEST_INPUT_STALE_MS ?? 2500),
)
/** A guest who stops sending input entirely (closed tab) frees the slot. */
export const IDLE_END_MS = Math.max(
  15000,
  Number(process.env.GUEST_IDLE_END_MS ?? 45000),
)

const TOKEN_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const FILLER_NAMES = ['MossByte', 'FuseBox', 'SneakyFern', 'BoomBean', 'PixelMoth',
  'GreenGoblin', 'DustBunny', 'LimeWire', 'TinyMeteor', 'NightSprout', 'CrispyLeaf',
  'OopsKaboom', 'StaticSlug', 'MintCondition', 'SpicyPebble', 'PocketChaos']

// Confirmed events may still be waiting for the controller to consume them
// when the gateway restarts. Keep those buffers, not only their id counter.
export function restoreGuestHistory(previous = {}) {
  const keep = (values) => Array.isArray(values)
    ? values.filter((e) => Number.isSafeInteger(e?.id) && e.id > 0).slice(-24)
    : []
  const events = keep(previous?.events)
  const chat = keep(previous?.chat)
  const seq = Number.isSafeInteger(previous?.seq) ? previous.seq : 0
  return { seq: Math.max(0, seq, ...events.map((e) => e.id), ...chat.map((e) => e.id)), events, chat }
}

/** Minecraft-safe viewer nickname. Rejects anything unusable. */
export function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[^A-Za-z0-9_]/g, '').trim().slice(0, 14)
  return name.length >= 2 && name.length <= 14 ? name : null
}

export class GuestQueue {
  constructor({
    now = Date.now,
    random = Math.random,
    makeToken = null,
    turnEveryMs = TURN_EVERY_MS,
    turnMaxMs = TURN_MAX_MS,
    maxQueue = MAX_QUEUE,
    idleEndMs = IDLE_END_MS,
    reservedNames = [],
    fillersEnabled = false,
    fillerTurnMs = 60000,
    fillerEveryMs = turnEveryMs,
    fillerYieldMs = 8000,
  } = {}) {
    this.now = now
    this.random = random
    this.makeToken = makeToken
    this.turnEveryMs = turnEveryMs
    this.turnMaxMs = turnMaxMs
    this.maxQueue = maxQueue
    this.idleEndMs = idleEndMs
    this.fillersEnabled = fillersEnabled
    this.fillerTurnMs = fillerTurnMs
    this.fillerEveryMs = fillerEveryMs
    this.fillerYieldMs = fillerYieldMs
    this.fillerTarget = 1 + Math.floor(this.random() * 5)
    this.nextFillerAt = now()
    this.lastSpawnKind = null
    // Case-insensitive reserved names: clankers, camera/mirror accounts and
    // the villager pool. A guest stealing one of these would kick the real
    // player on an offline-mode server.
    this.reserved = new Set(reservedNames.map((n) => String(n).toLowerCase()))
    this.queue = [] // {id, token, nickname, joinedAt}
    this.active = null // {id, token, nickname, botName, startedAt, endsAt, spawned}
    this.nextSlotAt = now()
    this.lastSpawnAt = -Infinity
    this.seq = 0
  }

  #token() {
    if (this.makeToken) return this.makeToken()
    let token = ''
    for (let i = 0; i < 24; i++)
      token += TOKEN_ALPHABET[Math.floor(this.random() * TOKEN_ALPHABET.length)]
    return token
  }

  status() {
    const now = this.now()
    return {
      queueLength: this.queue.length,
      queuePreview: this.queue.slice(0, 5).map((e) => e.nickname),
      queueEntries: this.queue.slice(0, 5).map(({ id, nickname }) => ({ id, nickname })),
      active: this.active
        ? {
            nickname: this.active.nickname,
            remainingMs: Math.max(0, this.active.endsAt - now),
          }
        : null,
      nextTurnInMs: Math.max(0, Math.max(this.nextSlotAt, this.active?.endsAt ?? 0) - now),
      turnEveryMs: this.turnEveryMs,
      turnMaxMs: this.turnMaxMs,
      acceptingJoins: this.queue.filter((e) => e.kind === 'human').length < this.maxQueue,
    }
  }

  join(nickname) {
    const name = sanitizeNickname(nickname)
    if (!name) return { error: 'Pick a name: 2-14 letters, numbers or _' }
    // Reserved names kick real players on an offline-mode server; mirror and
    // camera account prefixes (View*/Cam*) are exempt from guard combat, so
    // a guest must never wear them either.
    if (this.reserved.has(name.toLowerCase()))
      return { error: 'That name belongs to the village' }
    if (/^(view|cam|flagsetup)/i.test(name))
      return { error: 'That name is reserved for the arena crew' }
    if (this.active?.nickname.toLowerCase() === name.toLowerCase())
      return { error: 'That name is playing right now' }
    if (this.queue.some((e) => e.kind === 'human' && e.nickname.toLowerCase() === name.toLowerCase()))
      return { error: 'Someone with that name is already queued' }
    if (this.queue.filter((e) => e.kind === 'human').length >= this.maxQueue)
      return { error: 'The creeper queue is full right now' }
    // Humans go ahead of waiting clankers, preserving human FIFO and the
    // existing queue names. Only a clanker with the requested name withdraws.
    this.queue = this.queue.filter((e) => e.kind === 'human' || e.nickname.toLowerCase() !== name.toLowerCase())
    if (this.active?.kind === 'clanker') {
      this.active.yieldAt = Math.min(this.active.yieldAt ?? Infinity, this.now() + this.fillerYieldMs)
      this.active.endsAt = Math.min(this.active.endsAt, this.active.yieldAt)
    }
    if (this.lastSpawnKind === 'clanker') this.nextSlotAt = this.now()
    const entry = {
      id: ++this.seq,
      token: this.#token(),
      nickname: name,
      kind: 'human',
      joinedAt: this.now(),
    }
    const position = this.queue.filter((e) => e.kind === 'human').length + 1
    this.queue.splice(position - 1, 0, entry)
    // No shortcut for boom-and-rejoin: the next slot stays booked at
    // last-spawn + cadence. An idle stream (overdue slot) starts immediately
    // for whoever is first — nothing to adjust here.
    return {
      ok: true,
      token: entry.token,
      nickname: entry.nickname,
      position,
    }
  }

  leave(token) {
    const index = this.queue.findIndex((e) => e.token === token)
    if (index === -1) return false
    this.queue.splice(index, 1)
    return true
  }

  position(token) {
    const index = this.queue.findIndex((e) => e.token === token)
    return index === -1 ? null : { position: index + 1, nickname: this.queue[index].nickname }
  }

  setFillersEnabled(enabled) {
    this.fillersEnabled = Boolean(enabled)
    if (!enabled) this.queue = this.queue.filter((e) => e.kind === 'human')
  }

  refill() {
    const now = this.now()
    if (!this.fillersEnabled || now < this.nextFillerAt) return
    if (this.queue.length >= Math.min(5, this.maxQueue, this.fillerTarget)) return
    const taken = new Set([...this.reserved, ...this.queue.map((e) => e.nickname.toLowerCase()),
      this.active?.nickname.toLowerCase()])
    let nickname
    for (let i = 0; i < FILLER_NAMES.length + 1; i++) {
      const base = FILLER_NAMES[(Math.floor(this.random() * FILLER_NAMES.length) + i) % FILLER_NAMES.length]
      const candidate = i === FILLER_NAMES.length ? `Fuse_${++this.seq}` : base
      if (!taken.has(candidate.toLowerCase())) { nickname = candidate; break }
    }
    if (!nickname) return
    this.queue.push({ id: ++this.seq, token: this.#token(), nickname, kind: 'clanker', joinedAt: now })
    this.nextFillerAt = now + 3000 + Math.floor(this.random() * 5000)
  }

  /** Advance the schedule. Returns pending transitions for the gateway:
   * {spawn: entry} when a turn should start, {end: {entry, reason}} when the
   * active turn hit its cap or went idle. */
  tick() {
    const now = this.now()
    this.refill()
    if (this.active) {
      if (now >= this.active.endsAt) {
        const entry = this.active
        this.active = null
        return { end: { entry, reason: entry.yieldAt ? 'yield' : 'timeout' } }
      }
      if (
        this.active.cameraReadyAt &&
        now - (this.active.lastInputAt ?? this.active.startedAt) > this.idleEndMs
      ) {
        const entry = this.active
        this.active = null
        return { end: { entry, reason: 'idle' } }
      }
    }
    if (!this.active && this.queue.length > 0 && now >= this.nextSlotAt) {
      const [entry] = this.queue.splice(0, 1)
      this.active = {
        ...entry,
        botName: null,
        startedAt: now,
        endsAt: now + (entry.kind === 'clanker' ? this.fillerTurnMs : this.turnMaxMs),
        spawned: false,
      }
      this.lastSpawnAt = now
      this.lastSpawnKind = entry.kind
      this.nextSlotAt = now + (entry.kind === 'clanker' ? this.fillerEveryMs : this.turnEveryMs)
      this.fillerTarget = 1 + Math.floor(this.random() * 5)
      this.nextFillerAt = now
      this.refill()
      return { spawn: this.active }
    }
    return {}
  }

  /** The gateway confirms the guest bot exists (or failed to spawn). */
  markSpawned(botName, token = null) {
    if (!this.active || (token && this.active.token !== token)) return
    this.active.botName = botName
    this.active.spawned = true
  }

  /** Camera startup is not player idling. Start the idle clock when the
   * guest can first see and control the game. */
  markCameraReady(token = null) {
    if (!this.active || (token && this.active.token !== token)) return
    if (this.active.cameraReadyAt) return
    this.active.cameraReadyAt = this.now()
    this.active.lastInputAt = this.active.cameraReadyAt
    // Loading an official Minecraft client can take tens of seconds. Give
    // the human the full turn after the camera actually connects.
    this.active.endsAt = Math.max(this.active.endsAt, this.active.cameraReadyAt + this.turnMaxMs)
  }

  /** Explicit turn end: boom, death, or the human disconnected. */
  finishActive(reason, token = null) {
    if (!this.active || (token && this.active.token !== token)) return null
    const entry = this.active
    this.active = null
    return { entry, reason }
  }

  controlsFor(token) {
    return this.active?.kind === 'human' && this.active.token === token ? this.active : null
  }

  /** Stop moving when the browser stopped sending input. */
  isInputStale(entry) {
    return this.now() - (entry.lastInputAt ?? 0) > INPUT_STALE_MS
  }
}

export { randomUUID }
