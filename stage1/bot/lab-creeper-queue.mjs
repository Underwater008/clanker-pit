// Gateway integration on fixed isolated ports. No production queue or models.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Rcon } from 'rcon-client'

const data = mkdtempSync(join(tmpdir(), 'clanker-queue-lab-'))
const r = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
writeFileSync(join(data, 'village.json'), JSON.stringify({ flag: { x: 0, y: -61, z: 0 } }))
let gateway
let logs = ''
async function request(path, body) {
  const res = await fetch(`http://127.0.0.1:18090/${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000) })
  const result = await res.json()
  assert.equal(res.status, 200, JSON.stringify(result))
  return result
}
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(200) }
  throw new Error('Queue lab condition timed out')
}
try {
  await r.send('difficulty normal')
  await r.send('fill -15 -60 -15 15 -55 15 air')
  await r.send('fill -15 -61 -15 15 -61 15 bedrock')
  gateway = spawn(process.execPath, [fileURLToPath(new URL('./guest-gateway.mjs', import.meta.url))], {
    env: { ...process.env, MODEL_MODE: 'off', BOT_DATA_DIR: data, MC_HOST: '127.0.0.1',
      MC_PORT: '25566', RCON_PORT: '25576', RCON_PASSWORD: 'clanker-lab', GUEST_FILLERS: '1',
      GUEST_PORT: '18090', MIRROR_PORT_BASE: '25690', MIRROR_INDEX: '4' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  gateway.stdout.on('data', (b) => { logs += b })
  gateway.stderr.on('data', (b) => { logs += b })
  await until(() => logs.includes('gateway_up'))
  const initial = await until(async () => {
    const s = await request('status')
    return s.active?.position && s.queueLength ? s : null
  })
  assert.ok(initial.queueLength <= 5)
  assert.ok(!('kind' in initial.active) && !('fillersEnabled' in initial))
  assert.ok(initial.queueEntries.every((entry) => !('kind' in entry)))
  assert.ok(!('camera' in initial), 'Anonymous status must not disclose the active camera type')
  // Restart cleanup leaves killed mobs visible during their death animation.
  // Inspect the new spawn's UUID, never an arbitrary tagged entity.
  const spawned = logs.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  }).find((event) => event.event === 'auto_creeper_spawned' && event.nickname === initial.active.nickname)
  assert.ok(spawned?.uuid, 'The current native spawn must be confirmed')
  const nativeName = await r.send(`data get entity ${spawned.uuid} CustomName`)
  assert.ok(nativeName.includes(initial.active.nickname), 'Queue name must be the native nameplate')
  const joinedAt = Date.now()
  const human = await request('join', { nickname: 'QueueHumanLab' })
  assert.equal(human.position, 1)
  const waiting = await request('status')
  assert.equal(waiting.queuePreview[0], 'QueueHumanLab')
  assert.ok(initial.queuePreview.every((name) => waiting.queuePreview.includes(name)))
  assert.ok(!('kind' in waiting.queueEntries[0]))
  const playing = await until(async () => {
    const s = await request('status', { token: human.token })
    return s.active?.nickname === 'QueueHumanLab' && s.camera && s.camera.status !== 'idle' ? s : null
  }, 12000)
  assert.ok(Date.now() - joinedAt < 12000, 'No human waits a filler cadence')
  assert.ok(!('token' in playing.active))
  for (const path of ['video-auth', 'camera-view']) {
    const response = await fetch(`http://127.0.0.1:18090/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: human.token, mode: 'first' }),
    })
    assert.equal(response.status, path === 'video-auth' ? 403 : 409,
      'Camera checks must retain token context while the private camera starts')
  }
  assert.ok(!('camera' in await request('status')), 'Camera state belongs to the matching player token')
  await request('leave', { token: human.token })
  await until(async () => !(await request('status')).active)
  console.log(JSON.stringify({ event: 'CREEPER_QUEUE_LAB_PASS', queueMatchesNativeName: true,
    waitingClankersPreserved: true, humanPriority: true, publicTokensHidden: true }))
} catch (e) {
  console.error(logs.slice(-10000))
  throw e
} finally {
  if (gateway && gateway.exitCode === null) {
    const exited = once(gateway, 'exit')
    gateway.kill('SIGTERM')
    await exited
  }
  await r.end()
  rmSync(data, { recursive: true, force: true })
}
