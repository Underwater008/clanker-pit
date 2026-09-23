// Isolated native-view diagnostic: 25566/25576, read-only mirror 25590.
// A test fixture moves the stationary subject between land and full submersion.
// Write "water" to LAB_PHASE_FILE to submerge; delete it or write "land" to exit.
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { createNativeMirror } from './native-mirror.mjs'

const phaseFile = process.env.LAB_PHASE_FILE
if (!phaseFile) throw new Error('LAB_PHASE_FILE is required')
const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'WaterLab', auth: 'offline' })
const mirror = createNativeMirror({ port: 25590, name: 'WaterLab', statePath: `${phaseFile}.mirror.json`,
  log: (event, data) => console.log(JSON.stringify({ event, ...data })) })
mirror.attach(bot)
let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
try {
  await once(bot, 'spawn')
  bot.physicsEnabled = false
  for (const command of [
    'forceload add 32 -8 48 8', 'fill 34 -61 -6 46 -53 6 glass',
    'fill 35 -60 -5 45 -54 5 water', 'fill 34 -52 -6 46 -46 6 air',
    'gamemode survival WaterLab', 'clear WaterLab', 'tp WaterLab 40.5 -52 0.5 0 10',
  ]) await rcon.send(command)
  let previous = 'land'
  console.log(JSON.stringify({ event: 'LAB_LAND', mirror: 25590 }))
  const end = Date.now() + 240000
  while (!stopping && Date.now() < end) {
    let phase = 'land'
    try { phase = readFileSync(phaseFile, 'utf8').trim() } catch {}
    if (phase !== previous) {
      await rcon.send(`tp WaterLab 40.5 ${phase === 'water' ? -59 : -52} 0.5 0 10`)
      previous = phase
      console.log(JSON.stringify({ event: phase === 'water' ? 'LAB_SUBMERGED' : 'LAB_LAND' }))
    }
    await sleep(250)
  }
} finally {
  mirror.close(); bot.quit()
  await rcon.send('forceload remove 32 -8 48 8').catch(() => {})
  await rcon.end()
}
