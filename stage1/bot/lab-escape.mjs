// Isolated water-escape regression: scripted RCON terrain/threat/damage only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { installSurvival } from './survival.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'EscapeLab', auth: 'offline' })
const skills = installSurvival(bot, { camp: null, recent: [], cooldowns: {}, plan: { goal: 'explore' } },
  (event, data) => console.log(JSON.stringify({ event, ...data })))
const timer = setTimeout(() => { console.error('ESCAPE_LAB_TIMEOUT'); skills.stop(); bot.quit(); rcon.end(); process.exitCode = 1 }, 45000)
try {
  await once(bot, 'spawn')
  await sleep(3500) // Vanilla grants a newly joined player temporary damage immunity.
  for (const command of [
    'difficulty normal', 'time set noon', 'kill @e[type=zombie]',
    'gamemode survival EscapeLab', 'effect clear EscapeLab',
    'fill -10 -60 -6 12 -53 6 air', 'fill -10 -61 -6 12 -61 6 grass_block',
    'fill -1 -60 -2 2 -60 2 water',
    'fill 3 -60 -3 6 -60 3 grass_block',
    'tp EscapeLab 0.5 -60 0.5',
    'summon zombie -3.5 -60 0.5 {NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:["escape_lab"]}',
    'effect give @e[tag=escape_lab] fire_resistance 60 1 true',
  ]) await rcon.send(command)
  await sleep(800)
  const wetDeadline = Date.now() + 3000
  while (!bot.entity.isInWater && Date.now() < wetDeadline) await sleep(25)
  assert.equal(bot.entity.isInWater, true, 'Fixture must start swimming')
  assert.equal(skills.emergency(), 'flee')
  const before = bot.entity.position.clone()
  let hurt = 0
  bot.on('entityHurt', (entity) => { if (entity === bot.entity) hurt++ })
  const escaped = skills.execute('flee')
  await sleep(300)
  const damage = await rcon.send('damage EscapeLab 1 minecraft:generic')
  assert.match(damage, /Applied 1.*damage to EscapeLab/, 'Fixture damage must be accepted by the server')
  const result = await escaped
  await sleep(100)
  const moved = before.distanceTo(bot.entity.position)
  assert.ok(hurt > 0, 'Server must deliver damage during the escape')
  assert.ok(moved >= 1.5, `Escape must make real positional progress; moved ${moved}`)
  assert.ok(bot.entity.position.x > before.x, 'Escape must move away from the zombie')
  assert.match(await rcon.send('data get entity EscapeLab Pos'), /EscapeLab has the following entity data/)
  console.log(JSON.stringify({ event: 'LAB_ESCAPE_PASS', moved, hurt, result }))
} finally {
  clearTimeout(timer)
  await rcon.send('kill @e[tag=escape_lab]').catch(() => {})
  skills.stop(); bot.quit(); rcon.end()
}
