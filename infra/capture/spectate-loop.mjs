// Maintains the operator's wide spectator camera and legacy POV bindings.
// Every 20 s: restore the village overview and any non-mirrored POV cameras.
// Self-heals after bot reconnects, camera reconnects, or server restarts.
// Run ON the pod: node spectate-loop.mjs   (uses bots/node_modules for rcon-client)
import { Rcon } from 'rcon-client'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BINDINGS = [
  ['CamCinder', 'Cinder'],
  ['CamVex', 'Vex'],
  ['CamMira', 'Mira'],
  ['CamTally', 'Tally'],
]
// Player feeds now connect to read-only mirrors; only the wide camera is a spectator.
const nativeViews = process.env.NATIVE_MIRRORS !== '0'
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PASSWORD = process.env.RCON_PASSWORD ?? 'clanker-dev'
const PORT = Number(process.env.RCON_PORT ?? 25575)
const VILLAGE_PATH = join(process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state', 'village.json')
const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

function villageOverview() {
  if (process.env.SCENARIO === 'survival') return null
  try {
    const flag = JSON.parse(readFileSync(VILLAGE_PATH, 'utf8')).flag
    if (!flag || !['x', 'y', 'z'].every((key) => Number.isFinite(flag[key]))) return null
    if (Math.abs(flag.x) > 29999800 || Math.abs(flag.z) > 29999800 || flag.y < -64 || flag.y > 299) return null
    // Operator camera fixture only: these coordinates never enter clanker
    // observations. Look north-west over the gate road toward the Server.
    // Vanilla /teleport facing computes yaw/pitch from the camera eye position.
    return `teleport ClankerCam ${flag.x + 24.5} ${flag.y + 20} ${flag.z + 28.5} facing ${flag.x + 0.5} ${flag.y + 1.5} ${flag.z + 0.5}`
  } catch {
    // Survival rounds have no village marker. Preserve their existing camera.
    return null
  }
}

async function main() {
  while (true) {
    let rcon
    try {
      rcon = await Rcon.connect({ host: HOST, port: PORT, password: PASSWORD, timeout: 5000 })
      rcon.on('error', (e) => log('rcon_error', { error: String(e).slice(0, 120) }))
      log('rcon_connected')
      while (true) {
        await rcon.send('gamemode spectator ClankerCam')
        const overview = villageOverview()
        if (overview) await rcon.send(overview)
        for (const [cam, target] of nativeViews ? [] : BINDINGS) {
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
