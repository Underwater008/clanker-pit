// Labeled round fixture: hand the first clanker two starter water buckets
// once the cast is online, so the coolant loop can start before the village's
// iron industry is real. flag-setup.mjs places the chest and monument before
// the bots exist; this companion runs AFTER the controller starts (pod-
// bootstrap schedules it) and waits for the first listed clanker to join.
// Idempotent: the grant is recorded in its own marker file — never in
// village.json, which the running controller owns and rewrites.
//
//   node fixture-grant.mjs        (waits up to 5 minutes for the cast)
import './env.mjs'
import { writeFileSync, readFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon } from 'rcon-client'
import { createVillageState } from './village.mjs'

const DATA_DIR = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const RCON_PORT = Number(process.env.RCON_PORT ?? 25575)
const RCON_PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'
const WAIT_MS = Number(process.env.FIXTURE_GRANT_WAIT_MS ?? 300000)
const MARKER = join(DATA_DIR, 'fixture-grant.json')
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

const village = createVillageState({ path: join(DATA_DIR, 'village.json') })
if (!village.exists) {
  log('grant_skipped', { reason: 'no village fixture' })
  process.exit(0)
}
try {
  const marker = JSON.parse(readFileSync(MARKER, 'utf8'))
  if (marker.grantedAt) {
    log('grant_skipped', { reason: 'starter buckets already granted', grantedAt: marker.grantedAt })
    process.exit(0)
  }
  // A previous process may have sent /give before losing its acknowledgement.
  // Never infer that a missing success marker means the grant did not happen.
  log('grant_blocked', { reason: 'pending or unrecognized grant marker; inspect the recipient inventory and server log before operator reconciliation', target: marker.grantedTo })
  process.exit(1)
} catch (e) {
  if (e.code !== 'ENOENT') {
    log('grant_blocked', { reason: 'grant marker could not be read safely', error: String(e).slice(0, 160) })
    process.exit(1)
  }
}
function durableWrite(path, data, flags) {
  const fd = openSync(path, flags)
  try {
    writeFileSync(fd, JSON.stringify(data))
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function syncDirectory() {
  const fd = openSync(DATA_DIR, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
// Hand the starter buckets to the first listed clanker (the industrious
// one), not a hardcoded name.
const RECIPIENT =
  (process.env.BOT_NAMES ?? 'Cinder,Vex,Mira,Tally').split(',')[0]?.trim() ||
  village.raw.population?.[0] ||
  'Cinder'

if (!/^[A-Za-z0-9_]{1,16}$/.test(RECIPIENT)) throw new Error('Invalid fixture recipient Minecraft name')

const deadline = Date.now() + WAIT_MS
let rcon = null
let attempted = false
let granted = false
try {
  while (Date.now() < deadline) {
    try {
      rcon ??= await Rcon.connect({
        host: HOST,
        port: RCON_PORT,
        password: RCON_PASSWORD,
        timeout: 5000,
      })
      const list = await rcon.send('list')
      // Exact-name match: "CinderFan" must never satisfy a Cinder check.
      const online = String(list ?? '')
        .replace(/^.*?:/, '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      if (online.includes(RECIPIENT.toLowerCase())) {
        // Exclusive, durable intent BEFORE the external side effect. Concurrent
        // invocations and process crashes cannot silently duplicate this grant.
        const pending = { status: 'pending', attemptedAt: new Date().toISOString(), grantedTo: RECIPIENT, item: 'minecraft:water_bucket', count: 2 }
        try {
          durableWrite(MARKER, pending, 'wx')
          syncDirectory()
        } catch (e) {
          log('grant_blocked', { reason: e.code === 'EEXIST' ? 'another grant attempt already owns the marker' : 'could not persist grant intent', error: String(e).slice(0, 160) })
          process.exitCode = 1
          break
        }
        attempted = true
        const give = await rcon.send(`give ${RECIPIENT} minecraft:water_bucket 2`)
        if (!/^Gave 2\b/i.test(String(give ?? ''))) {
          log('grant_uncertain', { response: String(give).slice(0, 160), note: 'pending marker retained; no automatic retry' })
          process.exitCode = 1
          break
        }
        const complete = { ...pending, status: 'granted', grantedAt: new Date().toISOString() }
        const temporary = `${MARKER}.${process.pid}.tmp`
        durableWrite(temporary, complete, 'wx')
        renameSync(temporary, MARKER)
        syncDirectory()
        granted = true
        log('fixture_grant', { target: RECIPIENT, response: String(give).slice(0, 120) })
        // Announcement is optional and cannot turn a successful grant into a
        // retry. The final marker is already durable at this point.
        try {
          await rcon.send(`say [Round setup] ${RECIPIENT} was handed two starter buckets (round fixture, labeled).`)
        } catch (e) {
          log('grant_announcement_failed', { error: String(e).slice(0, 120) })
        }
        log('grant_done')
        break
      }
    } catch (e) {
      if (attempted) {
        log('grant_uncertain', { error: String(e).slice(0, 160), note: 'grant intent retained; inspect inventory and server log, do not retry automatically' })
        process.exitCode = 1
        break
      }
      log('grant_retry', { error: String(e).slice(0, 120) })
      await rcon?.end().catch(() => {})
      rcon = null
    }
    await sleep(10000)
  }
  if (!granted && !attempted && !process.exitCode) {
    log('grant_timeout', { target: RECIPIENT, note: 'no give attempted; run node fixture-grant.mjs again later' })
    process.exitCode = 1
  }
} finally {
  await rcon?.end().catch(() => {})
}
