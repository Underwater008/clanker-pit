// Keeps the four POV camera accounts bound to their targets.
// Every 20 s: ensure each camera is a spectator and spectating its contestant.
// Self-heals after bot reconnects, camera reconnects, or server restarts.
// Run ON the pod: node spectate-loop.mjs   (uses bots/node_modules for rcon-client)
import { Rcon } from 'rcon-client'

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
  const rcon = await Rcon.connect({ host: HOST, port: 25575, password: PASSWORD })
  log('rcon_connected')
  const tick = async () => {
    for (const [cam, target] of BINDINGS) {
      try {
        await rcon.send(`gamemode spectator ${cam}`)
        await rcon.send(`spectate ${target} ${cam}`)
      } catch (e) {
        log('binding_error', { cam, target, error: String(e).slice(0, 120) })
      }
    }
  }
  await tick()
  setInterval(tick, 20_000)
}
process.on('uncaughtException', (e) => log('uncaught', { error: String(e).slice(0, 200) }))
main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1) })
