// Keeps the four POV camera accounts bound to their targets.
// Every 20 s: ensure each camera is a spectator and spectating its contestant.
// Self-heals after bot reconnects, camera reconnects, or server restarts.
// Run ON the pod: node spectate-loop.mjs   (uses bots/node_modules for rcon-client)
import { Rcon } from 'rcon-client'
import { setTimeout as sleep } from 'node:timers/promises'

const BINDINGS = [
  ['CamCinder', 'Cinder'],
  ['CamVex', 'Vex'],
  ['CamMira', 'Mira'],
  ['CamTally', 'Tally'],
]
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'
const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

async function main() {
  while (true) {
    let rcon
    try {
      rcon = await Rcon.connect({ host: HOST, port: 25575, password: PASSWORD, timeout: 5000 })
      rcon.on('error', (e) => log('rcon_error', { error: String(e).slice(0, 120) }))
      log('rcon_connected')
      while (true) {
        await rcon.send('gamemode spectator ClankerCam')
        for (const [cam, target] of BINDINGS) {
          await rcon.send(`gamemode spectator ${cam}`)
          await rcon.send(`spectate ${target} ${cam}`)
        }
        await sleep(20_000)
      }
    } catch (e) {
      log('rcon_reconnecting', { error: String(e).slice(0, 120) })
    } finally {
      await rcon?.end().catch(() => {})
    }
    await sleep(5000)
  }
}
main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1) })
