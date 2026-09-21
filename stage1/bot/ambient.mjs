// Ambient cast: the four Clanker Pit contestants living in the arena 24/7.
// No model calls — free-roam behavior so the 24/7 feed is alive between matches.
// Each bot: wander to random waypoints, pause, sometimes face a neighbor, repeat forever.
// Reconnects indefinitely on kicks/disconnects. Run ON the pod: node ambient.mjs
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const CAST = ['Cinder', 'Vex', 'Mira', 'Tally']

const log = (bot, event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), bot, event, ...data }))

function spawnActor(name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', hideErrors: true })
  bot.loadPlugin(pathfinder)

  let stopping = false
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function wander() {
    const mcData = (await import('minecraft-data')).default(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
    while (!stopping && bot.entity) {
      try {
        const p = bot.entity.position
        const target = p.offset(
          Math.floor(Math.random() * 61) - 30,
          0,
          Math.floor(Math.random() * 61) - 30,
        )
        // 60% stroll somewhere, 25% approach a neighbor, 15% stand and watch
        const roll = Math.random()
        if (roll < 0.6) {
          await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2), { timeout: 15000 })
        } else if (roll < 0.85) {
          const neighbor = Object.values(bot.entities).find(
            (e) => e.username && e.username !== name && e.position.distanceTo(p) < 32,
          )
          if (neighbor) {
            await bot.pathfinder.goto(
              new goals.GoalNear(neighbor.position.x, neighbor.position.y, neighbor.position.z, 4),
              { timeout: 12000 },
            )
            await bot.lookAt(neighbor.position.offset(0, 1.6, 0))
          } else {
            await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2), { timeout: 15000 })
          }
        }
        await sleep(3000 + Math.random() * 8000)
      } catch {
        await sleep(4000) // pathfinding hiccup — try again next loop
      }
    }
  }

  bot.once('spawn', () => {
    log(name, 'spawn', { pos: bot.entity.position })
    wander().catch(() => {})
  })
  bot.on('kicked', (r) => log(name, 'kicked', { reason: String(r).slice(0, 120) }))
  bot.on('error', (e) => log(name, 'error', { message: String(e).slice(0, 120) }))
  bot.on('end', () => {
    stopping = true
    log(name, 'end', { rejoinInMs: 5000 })
    setTimeout(() => spawnActor(name), 5000)
  })
  return bot
}

// Stagger joins so they don't pile onto the server tick at once
CAST.forEach((name, i) => setTimeout(() => spawnActor(name), i * 3000))
log('director', 'ambient_cast_starting', { cast: CAST })
