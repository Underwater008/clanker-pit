// Scripted guest gateway verification; hard-wired to the isolated lab only.
// No models, no public queue, no production fixtures or player state.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Rcon } from 'rcon-client'

const data = mkdtempSync(join(tmpdir(), 'clanker-guest-lab-'))
const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
writeFileSync(join(data, 'village.json'), JSON.stringify({ flag: { x: 0, y: -60, z: 0 } }))
let gateway
const logs = []
async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:18090/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  })
  return { status: response.status, body: await response.json() }
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch {}
    await sleep(200)
  }
  throw new Error('Guest lab condition timed out')
}
async function start() {
  gateway = spawn(process.execPath, [fileURLToPath(new URL('./guest-gateway.mjs', import.meta.url))], {
    env: { ...process.env, MODEL_MODE: 'off', BOT_DATA_DIR: data, MC_HOST: '127.0.0.1',
      MC_PORT: '25566', RCON_PORT: '25576', RCON_PASSWORD: 'clanker-lab',
      GUEST_PORT: '18090', MIRROR_PORT_BASE: '25690', MIRROR_INDEX: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  gateway.stdout.on('data', (buffer) => logs.push(buffer.toString()))
  gateway.stderr.on('data', (buffer) => logs.push(buffer.toString()))
  await until(async () => (await request('status')).status === 200)
}
async function stop() {
  if (!gateway || gateway.exitCode !== null) return
  const exited = once(gateway, 'exit')
  gateway.kill('SIGTERM')
  await exited
  gateway = null
}
const snapshot = () => JSON.parse(readFileSync(join(data, 'guest.json'), 'utf8'))
async function arrive(nickname) {
  const joined = await request('join', { nickname })
  assert.equal(joined.status, 200)
  const token = joined.body.token
  await until(async () => (await request('input', { token, keys: {} })).status === 200, 40000)
  const mirror = await until(() => {
    const state = JSON.parse(readFileSync(join(data, 'mirror-Guest.json'), 'utf8'))
    return state.ready && state.port === 25694 ? state : null
  }, 15000)
  assert.equal(mirror.name, 'Guest')
  assert.equal(mirror.ready, true, 'Guest mirror must be ready during an active turn')
  return token
}
try {
  await rcon.send('difficulty normal')
  await rcon.send('gamerule doMobSpawning false')
  await rcon.send('time set day')
  await start()
  const token = await arrive('GuestBoomLab')
  const before = await rcon.send('data get entity GuestBoomLab Pos')
  await request('input', { token, keys: { forward: true }, look: { yaw: 0, pitch: 0 } })
  await sleep(600)
  await request('input', { token, keys: {} })
  const after = await rcon.send('data get entity GuestBoomLab Pos')
  assert.notEqual(after, before, 'Guest movement must change authoritative server position')
  const boom = await request('input', { token, keys: {}, boom: true })
  assert.equal(boom.status, 200, JSON.stringify(boom.body))
  await until(() => snapshot().events?.some((e) => e.type === 'boom'))
  const events = snapshot().events
  assert.equal(events.filter((e) => e.type === 'boom').length, 1)
  const repeat = await request('input', { token, boom: true })
  assert.equal(repeat.status, 403)
  await stop()
  await start()
  assert.deepEqual(snapshot().events, events, 'Unconsumed confirmed boom must survive gateway restart')
  const leaveToken = await arrive('GuestLeaveLab')
  assert.equal((await request('leave', { token: leaveToken })).body.ok, true)
  assert.equal((await request('status')).body.active, null)
  await until(async () => !(await rcon.send('list')).includes('GuestLeaveLab'))
  console.log(JSON.stringify({ event: 'GUEST_LAB_PASS', movement: true, confirmedExplosions: 1,
    repeatRejected: true, persistedAcrossRestart: true, activeLeave: true, nativeMirrorReady: true }))
} catch (error) {
  console.error(logs.join('').slice(-14000))
  throw error
} finally {
  await stop()
  await rcon.send('difficulty peaceful').catch(() => {})
  await rcon.end()
  rmSync(data, { recursive: true, force: true })
}
