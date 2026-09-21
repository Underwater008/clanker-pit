// Ambient cast: the four Clanker Pit contestants living in the arena 24/7.
// Steering-based wandering (no pathfinder): walk a heading, hop over obstacles,
// sometimes drift toward a neighbor. Zero A* cost — the event loop stays free
// and the server keeps us connected. Run ON the pod: node ambient.mjs
import mineflayer from 'mineflayer'

const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const CAST = ['Cinder', 'Vex', 'Mira', 'Tally']

const log = (bot, event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), bot, event, ...data }))

function spawnActor(name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', hideErrors: true })
  let alive = false
  let timer = null
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function stopWalking() {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
  }

  async function behave() {
    while (alive) {
      const roll = Math.random()
      if (roll < 0.55) {
        // stroll in a random direction for 2–6 s
        const yaw = Math.random() * Math.PI * 2
        bot.setControlState('forward', true)
        bot.setControlState('sprint', Math.random() < 0.25)
        const until = Date.now() + 2000 + Math.random() * 4000
        while (Date.now() < until && alive) {
          await bot.look(yaw + (Math.random() - 0.5) * 0.4, 0, true)
          // hop when something's in the way (trees, hills)
          if (bot.entity?.isCollidedHorizontally) bot.setControlState('jump', true)
          else bot.setControlState('jump', false)
          await sleep(120)
        }
        stopWalking()
      } else if (roll < 0.8) {
        // drift toward a visible neighbor and watch them for a bit
        const neighbor = Object.values(bot.entities).find(
          (e) => e.username && e.username !== name && e.position.distanceTo(bot.entity.position) < 24,
        )
        if (neighbor) {
          const until = Date.now() + 3000 + Math.random() * 3000
          while (Date.now() < until && alive) {
            const d = neighbor.position.distanceTo(bot.entity.position)
            await bot.lookAt(neighbor.position.offset(0, 1.6, 0), true)
            bot.setControlState('forward', d > 4)
            if (bot.entity?.isCollidedHorizontally) bot.setControlState('jump', true)
            else bot.setControlState('jump', false)
            await sleep(150)
          }
          stopWalking()
        }
      } else {
        // stand and look around
        await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 0.4, true)
        await sleep(1500 + Math.random() * 4000)
      }
    }
  }

  bot.once('spawn', () => {
    log(name, 'spawn', { pos: bot.entity.position })
    alive = true
    behave().catch((e) => log(name, 'behave_error', { message: String(e).slice(0, 120) }))
  })
  bot.on('kicked', (r) => log(name, 'kicked', { reason: String(r).slice(0, 120) }))
  bot.on('error', (e) => log(name, 'error', { message: String(e).slice(0, 120) }))
  bot.on('end', () => {
    alive = false
    stopWalking()
    clearTimeout(timer)
    log(name, 'end', { rejoinInMs: 5000 })
    setTimeout(() => spawnActor(name), 5000)
  })
}

CAST.forEach((name, i) => setTimeout(() => spawnActor(name), i * 3000))
log('director', 'ambient_cast_starting', { cast: CAST, mode: 'steering' })
