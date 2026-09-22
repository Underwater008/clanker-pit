import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

// Run the exact CLI source with filesystem-backed state in a disposable folder.
// Only its external adapters are replaced: no .env loading, Minecraft, RCON
// sockets, or model/provider calls can occur in these tests.
function fixture(t, fault = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'clanker-grant-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  const rconModule = join(root, 'node_modules', 'rcon-client')
  mkdirSync(data)
  mkdirSync(rconModule, { recursive: true })
  copyFileSync(new URL('./fixture-grant.mjs', import.meta.url), join(root, 'fixture-grant.mjs'))
  writeFileSync(join(root, 'env.mjs'), '// Deliberately do not load credentials.\n')
  writeFileSync(join(root, 'village.mjs'), `
    import { readFileSync } from 'node:fs'
    export function createVillageState({ path }) {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return { exists: Boolean(raw.flag), raw }
    }
  `)
  writeFileSync(join(data, 'village.json'), JSON.stringify({ flag: { x: 0, y: 63, z: 0 }, population: ['FixtureTester'] }))
  writeFileSync(join(rconModule, 'package.json'), JSON.stringify({ name: 'rcon-client', type: 'module', exports: './index.mjs' }))
  writeFileSync(join(rconModule, 'index.mjs'), `
    import { appendFileSync, readFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { setTimeout as sleep } from 'node:timers/promises'
    const events = process.env.FIXTURE_TEST_EVENTS
    const marker = join(process.env.BOT_DATA_DIR, 'fixture-grant.json')
    export const Rcon = {
      connect: async () => ({
        send: async (command) => {
          const isGive = command.startsWith('give ')
          const isSay = command.startsWith('say ')
          const state = isGive || isSay ? JSON.parse(readFileSync(marker, 'utf8')).status : null
          appendFileSync(events, JSON.stringify({ command, markerStatus: state }) + '\\n')
          if (command === 'list') {
            if (process.env.FIXTURE_TEST_FAULT === 'concurrent') {
              // Both processes finish their initial marker check before either
              // can acquire the exclusive grant intent. Exercise the race.
              const deadline = Date.now() + 3000
              while (readFileSync(events, 'utf8').trim().split('\\n').map(JSON.parse).filter(e => e.command === 'list').length < 2) {
                if (Date.now() > deadline) throw new Error('test concurrency barrier timed out')
                await sleep(5)
              }
            }
            return 'There are 1 of a max of 20 players online: FixtureTester'
          }
          if (isGive) {
            if (process.env.FIXTURE_TEST_FAULT === 'give_ack_lost') throw new Error('give acknowledgement lost')
            if (process.env.FIXTURE_TEST_FAULT === 'give_rejected') return 'No player was found'
            return 'Gave 2 [Water Bucket] to FixtureTester'
          }
          if (isSay && process.env.FIXTURE_TEST_FAULT === 'say_failed') throw new Error('announcement failed')
          return 'ok'
        },
        end: async () => {},
      }),
    }
  `)
  const eventsPath = join(root, 'events.jsonl')
  writeFileSync(eventsPath, '')
  const markerPath = join(data, 'fixture-grant.json')
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'fixture-grant.mjs')], {
      cwd: root,
      env: {
        BOT_DATA_DIR: data,
        BOT_NAMES: 'FixtureTester',
        FIXTURE_GRANT_WAIT_MS: '5000',
        FIXTURE_TEST_EVENTS: eventsPath,
        FIXTURE_TEST_FAULT: fault,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
  return {
    run,
    markerPath,
    marker: () => JSON.parse(readFileSync(markerPath, 'utf8')),
    events: () => readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse),
  }
}

function gives(f) { return f.events().filter((e) => e.command.startsWith('give ')) }

for (const fault of ['none', 'say_failed']) {
  test(`grant is durable before announcement and never repeated (${fault})`, async (t) => {
    const f = fixture(t, fault)
    const first = await f.run()
    assert.equal(first.code, 0, first.output)
    const repeat = await f.run()
    assert.equal(repeat.code, 0, repeat.output)
    assert.equal(gives(f).length, 1)
    assert.equal(gives(f)[0].markerStatus, 'pending', 'intent must exist before external give')
    assert.equal(f.events().find((e) => e.command.startsWith('say ')).markerStatus, 'granted', 'announcement must follow durable completion')
    assert.equal(f.marker().status, 'granted')
    assert.equal(f.marker().grantedTo, 'FixtureTester')
    assert.ok(f.marker().grantedAt)
    if (fault === 'say_failed') assert.match(first.output, /grant_announcement_failed/)
  })
}

for (const fault of ['give_ack_lost', 'give_rejected']) {
  test(`uncertain give retains pending intent and blocks retry (${fault})`, async (t) => {
    const f = fixture(t, fault)
    const first = await f.run()
    assert.equal(first.code, 1, first.output)
    assert.match(first.output, /grant_uncertain/)
    const repeat = await f.run()
    assert.equal(repeat.code, 1, repeat.output)
    assert.match(repeat.output, /grant_blocked/)
    assert.equal(gives(f).length, 1)
    assert.equal(f.marker().status, 'pending')
    assert.equal(f.events().filter((e) => e.command.startsWith('say ')).length, 0)
  })
}

test('corrupt intent cannot be mistaken for permission to give again', async (t) => {
  const f = fixture(t)
  writeFileSync(f.markerPath, '{invalid')
  const result = await f.run()
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /grant_blocked/)
  assert.deepEqual(f.events(), [])
})

test('concurrent grant processes have one exclusive winner and one give', async (t) => {
  const f = fixture(t, 'concurrent')
  const results = await Promise.all([f.run(), f.run()])
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 1], results.map((r) => r.output).join('\n'))
  assert.equal(f.events().filter((e) => e.command === 'list').length, 2)
  assert.equal(gives(f).length, 1)
  assert.equal(f.marker().status, 'granted')
  assert.ok(results.some((r) => /another grant attempt already owns the marker/.test(r.output)))
})
