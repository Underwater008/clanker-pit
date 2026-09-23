// Isolated 25566/25576 regression: an installed marker cannot hide leaves
// that later obstruct a founder's home spawn tile.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { homeBed } from './village.mjs'

const run = promisify(execFile)
const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const founders = ['Cinder', 'Vex', 'Mira', 'Tally']
const flag = new Vec3(40, -61, 40)
const dataDir = mkdtempSync(join(tmpdir(), 'home-beds-lab-'))
const bots = []
try {
  writeFileSync(join(dataDir, 'village.json'), JSON.stringify({ flag,
    founders, homeLots: Object.fromEntries(founders.map((name, index) => [name, index])) }))
  for (const name of founders) {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566,
      version: '1.21.1', username: name, auth: 'offline' })
    bots.push(bot)
    await once(bot, 'spawn')
  }
  for (const command of [
    'fill 28 -60 28 52 -58 52 air',
    'fill 28 -61 28 52 -61 52 grass_block',
    'tp Cinder 40.5 -60 40.5',
  ]) await rcon.send(command)
  const fixture = async () => {
    const { stdout } = await run(process.execPath, ['home-beds.mjs'], {
      cwd: new URL('.', import.meta.url), timeout: 30000,
      env: { ...process.env, BOT_DATA_DIR: dataDir, MC_HOST: '127.0.0.1',
        RCON_PORT: '25576', RCON_PASSWORD: 'clanker-lab' },
    })
    return JSON.parse(stdout.trim().split('\n').at(-1))
  }
  assert.equal((await fixture()).event, 'home_beds_ready')
  const spawn = homeBed(flag, 0).spawn
  await rcon.send(`setblock ${spawn.x} ${spawn.y + 1} ${spawn.z} oak_leaves`)
  const repaired = await fixture()
  assert.equal(repaired.event, 'home_beds_ready')
  assert.equal(repaired.clearedLeaves.length, 1)
  assert.match(await rcon.send(`execute if block ${spawn.x} ${spawn.y + 1} ${spawn.z} air`), /^Test passed/)
  for (const name of founders) {
    const home = homeBed(flag, founders.indexOf(name))
    assert.match(await rcon.send(`data get entity ${name} SpawnX`),
      new RegExp(`: ${home.spawn.x}$`))
  }
  console.log(JSON.stringify({ event: 'HOME_BEDS_REPAIR_PASS', clearedLeaves: repaired.clearedLeaves }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  for (const bot of bots) bot.quit()
  await rcon.end()
  rmSync(dataDir, { recursive: true, force: true })
}
