// Stage 0 Minecraft check: connect one bot, walk waypoints, report observations.
// Run ON the pod: node bot-walk.mjs
// Proves: protocol connection works, movement/pathfinding works, world observation works.
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pathfinderPkg

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const NAME = process.env.BOT_NAME ?? 'Cinder'

const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: NAME,
  auth: 'offline',
})

bot.loadPlugin(pathfinder)

bot.once('login', () => log('login', { username: bot.username }))
bot.once('error', (err) => log('error', { message: String(err) }))
bot.on('kicked', (reason) => log('kicked', { reason }))
bot.on('end', () => log('end'))
bot.on('death', () => log('death', { position: bot.entity?.position }))

bot.once('spawn', async () => {
  const mcData = (await import('minecraft-data')).default(bot.version)
  const moves = new Movements(bot, mcData)
  bot.pathfinder.setMovements(moves)

  log('spawn', {
    version: bot.version,
    position: bot.entity.position,
    health: bot.health,
    food: bot.food,
  })

  const waypoints = []
  const origin = bot.entity.position.floored()
  for (let i = 0; i < 5; i++) {
    waypoints.push(
      origin.offset(
        Math.floor(Math.random() * 41) - 20,
        0,
        Math.floor(Math.random() * 41) - 20,
      ),
    )
  }

  let completed = 0
  for (const wp of waypoints) {
    const goal = new goals.GoalNear(wp.x, wp.y, wp.z, 2)
    log('waypoint_start', { target: { x: wp.x, y: wp.y, z: wp.z } })
    try {
      await bot.pathfinder.goto(goal)
      completed++
      log('waypoint_reached', {
        target: { x: wp.x, y: wp.y, z: wp.z },
        position: bot.entity.position,
        health: bot.health,
      })
    } catch (err) {
      log('waypoint_failed', { target: { x: wp.x, y: wp.y, z: wp.z }, error: String(err) })
    }
  }

  // Observation sample: what does the bot perceive nearby?
  const entities = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 32)
    .map((e) => ({ name: e.name ?? e.username, kind: e.kind, dist: Math.round(e.position.distanceTo(bot.entity.position)) }))
  log('observation', { nearby_entities: entities, inventory: bot.inventory.items().map((i) => i.name) })

  log('stage0_result', {
    ok: completed === waypoints.length,
    waypoints_completed: completed,
    waypoints_total: waypoints.length,
  })
  bot.quit()
  process.exit(completed === waypoints.length ? 0 : 1)
})

setTimeout(() => {
  log('timeout', { seconds: 180 })
  process.exit(2)
}, 180_000)
