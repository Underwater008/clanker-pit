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
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
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
    log('grant_skipped', {
      reason: 'starter buckets already granted',
      grantedAt: marker.grantedAt,
    })
    process.exit(0)
  }
} catch {
  // No marker yet: proceed.
}
// Hand the starter buckets to the first listed clanker (the industrious
// one), not a hardcoded name.
const RECIPIENT =
  (process.env.BOT_NAMES ?? 'Cinder,Vex,Mira,Tally').split(',')[0]?.trim() ||
  village.raw.population?.[0] ||
  'Cinder'

const deadline = Date.now() + WAIT_MS
let rcon = null
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
        const give = await rcon.send(`give ${RECIPIENT} minecraft:water_bucket 2`)
        if (/no player|could not|incorrect|unknown/i.test(String(give ?? ''))) {
          log('grant_give_failed', { response: String(give).slice(0, 160) })
          await sleep(10000)
          continue
        }
        log('fixture_grant', { target: RECIPIENT, response: String(give).slice(0, 120) })
        await rcon.send(
          `say [Round setup] ${RECIPIENT} was handed two starter buckets (round fixture, labeled).`,
        )
        writeFileSync(
          MARKER,
          JSON.stringify({
            grantedAt: new Date().toISOString(),
            grantedTo: RECIPIENT,
          }),
        )
        log('grant_done')
        process.exit(0)
      }
    } catch (e) {
      log('grant_retry', { error: String(e).slice(0, 120) })
      rcon = null
    }
    await sleep(10000)
  }
  log('grant_timeout', {
    target: RECIPIENT,
    note: 'run node fixture-grant.mjs again later',
  })
  process.exitCode = 1
} finally {
  await rcon?.end().catch(() => {})
}
