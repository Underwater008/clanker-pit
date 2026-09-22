// Persistent survival cast: Kimi plans, Jev selects feasible skills, Mineflayer executes.
import './env.mjs'
import mineflayer from 'mineflayer'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { kimiPlan, jevChoose } from './llm.mjs'
import { createDecisionMaker } from './decision.mjs'
import { GOALS, installSurvival } from './survival.mjs'
import { createNativeMirror } from './native-mirror.mjs'

const STATE_PATH = process.env.STATE_PATH ?? '/workspace/arena/state.json'
const DATA_DIR = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const PLAN_INTERVAL = Math.max(
  90000,
  Number(process.env.PLAN_INTERVAL_MS ?? 300000),
)
const MODELS = process.env.MODEL_MODE !== 'off'
const MIRRORS = process.env.NATIVE_MIRRORS !== '0'
const STATE = {}
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(dirname(STATE_PATH), { recursive: true })
const IDENTITIES = {
  Cinder: {
    name: 'Cinder',
    dispositions: ['cautious', 'industrious', 'grudge-keeping'],
    current_goal: 'Build a reliable camp and become self-sufficient.',
  },
  Vex: {
    name: 'Vex',
    dispositions: ['bold', 'opportunistic', 'restless'],
    current_goal: 'Get good tools and collect the most valuable resources.',
  },
  Mira: {
    name: 'Mira',
    dispositions: ['methodical', 'observant', 'independent'],
    current_goal: 'Establish a useful workshop and explore for supplies.',
  },
  Tally: {
    name: 'Tally',
    dispositions: ['social', 'showy', 'competitive'],
    current_goal: 'Build something impressive and outwork the others.',
  },
}
const names = (process.env.BOT_NAMES ?? 'Cinder,Vex,Mira,Tally')
  .split(',')
  .filter(Boolean)
const log = (name, event, data = {}) =>
  console.log(
    JSON.stringify({ t: new Date().toISOString(), bot: name, event, ...data }),
  )
const actors = []
let stopping = false
function atomic(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}
const telemetry = setInterval(
  () => atomic(STATE_PATH, { updated: new Date().toISOString(), bots: STATE }),
  2000,
)

function actor(name, index) {
  const identity = IDENTITIES[name] ?? { ...IDENTITIES.Cinder, name }
  const saved = join(DATA_DIR, `${name}.json`)
  let state
  try {
    state = JSON.parse(readFileSync(saved, 'utf8'))
  } catch {
    state = {}
  }
  state = {
    camp: null,
    shelter: null,
    recent: [],
    cooldowns: {},
    plan: {
      goal: 'build_shelter',
      intention: 'Acquire wood, craft tools and build a small shelter.',
      steps: [],
      source: 'bootstrap',
    },
    ...state,
  }
  let bot,
    skills,
    connected = false,
    epoch = 0,
    planning = false,
    lastPlan = 0,
    failures = 0,
    task = 'connecting',
    staleRevision = 0
  const mirror = MIRRORS
    ? createNativeMirror({
        port: Number(process.env.MIRROR_PORT_BASE ?? 25580) + index,
        name,
        statePath: join(DATA_DIR, `mirror-${name}.json`),
        log: (e, d) => log(name, e, d),
      })
    : null
  function save() {
    state.recent = state.recent.slice(-16)
    atomic(saved, state)
  }
  function report() {
    STATE[name] = {
      offline: !connected,
      health: bot?.health ?? 0,
      food: bot?.food ?? 0,
      inventory:
        bot?.inventory
          ?.items()
          .map((i) => ({ name: i.name, count: i.count })) ?? [],
      activity: task,
      goal: state.plan.intention,
      plan: state.plan,
      position: bot?.entity?.position ?? null,
      camp: state.camp,
      shelter: state.shelter,
      recent: state.recent.slice(-4),
      nativeView: Boolean(mirror),
    }
  }
  const reportTimer = setInterval(report, 1000)
  async function plan() {
    if (
      !MODELS ||
      planning ||
      !connected ||
      Date.now() - lastPlan < PLAN_INTERVAL
    )
      return
    planning = true
    lastPlan = Date.now()
    const revision = staleRevision
    const thisEpoch = epoch
    log(name, 'kimi_request', { goal: state.plan.goal })
    try {
      const r = await kimiPlan({
        identity,
        observation: skills.observation(),
        memoryContext: state.recent.slice(-8),
        goals: GOALS,
      })
      if (!connected || epoch !== thisEpoch || revision !== staleRevision) {
        log(name, 'kimi_stale')
        return
      }
      if (r.error) {
        log(name, 'kimi_fallback', { error: r.error, kept: state.plan })
        return
      }
      state.plan = { ...r, source: 'kimi' }
      save()
      log(name, 'kimi_plan', r)
    } catch (e) {
      log(name, 'kimi_error', { error: String(e) })
    } finally {
      planning = false
    }
  }
  async function loop(thisEpoch) {
    // Jev decisions are requested while the previous action runs, so the bot
    // starts its next action immediately instead of idling between cycles.
    const decisions = MODELS
      ? createDecisionMaker({
          jevChoose,
          identity,
          getPlan: () => state.plan,
          skills,
          log: (e, d) => log(name, e, d),
          sleep,
        })
      : null
    while (connected && epoch === thisEpoch && !stopping) {
      try {
        void plan()
        let urgent = skills.emergency()
        let choice, source
        if (urgent) {
          decisions?.cancel()
          choice = urgent
          source = 'safety_reflex'
        } else if (MODELS) {
          const d = await decisions.next()
          if (epoch !== thisEpoch || !connected) break
          if (d.urgent) {
            choice = d.urgent
            source = 'safety_reflex'
          } else {
            choice = d.choice
            source = d.source
          }
        } else {
          const observation = skills.observation()
          choice = Object.keys(skills.candidates(observation))[0]
          source = 'test_policy'
        }
        urgent = skills.emergency()
        if (urgent) {
          decisions?.cancel()
          choice = urgent
          source = 'safety_reflex'
        }
        task = choice
        report()
        const before = bot.inventory
          .items()
          .map((i) => ({ name: i.name, count: i.count }))
        const started = Date.now()
        log(name, 'action_start', {
          action: choice,
          source,
          goal: state.plan.goal,
        })
        try {
          const result = await skills.execute(choice)
          if (epoch !== thisEpoch || !connected) break
          failures = 0
          const outcome = {
            action: choice,
            ok: true,
            result,
            at: new Date().toISOString(),
          }
          state.recent.push(outcome)
          log(name, 'action_result', {
            ...outcome,
            source,
            durationMs: Date.now() - started,
            before,
            after: bot.inventory
              .items()
              .map((i) => ({ name: i.name, count: i.count })),
          })
        } catch (e) {
          if (epoch !== thisEpoch || !connected) break
          failures++
          state.cooldowns[choice] =
            Date.now() + Math.min(90000, 15000 * failures)
          const outcome = {
            action: choice,
            ok: false,
            error: String(e).slice(0, 180),
            at: new Date().toISOString(),
          }
          state.recent.push(outcome)
          log(name, 'action_result', outcome)
          if (failures === 3) {
            lastPlan = Math.min(lastPlan, Date.now() - PLAN_INTERVAL)
            staleRevision++
          }
        }
        save()
        report()
        await sleep(MODELS ? 100 : 600)
      } catch (e) {
        log(name, 'loop_error', { error: String(e) })
        await sleep(2000)
      }
    }
  }
  function connect() {
    if (stopping) return
    const thisEpoch = ++epoch
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      version: '1.21.1',
      username: name,
      auth: 'offline',
      hideErrors: true,
      checkTimeoutInterval: 120000,
      viewDistance: 6,
    })
    mirror?.attach(bot)
    skills = installSurvival(bot, state, (e, d) => log(name, e, d))
    // Fail closed if a future dependency regression produces non-finite movement.
    const originalWrite = bot._client.write.bind(bot._client)
    bot._client.write = (packet, data) => {
      if (
        ['position', 'position_look', 'look'].includes(packet) &&
        Object.values(data).some(
          (v) => typeof v === 'number' && !Number.isFinite(v),
        )
      ) {
        log(name, 'invalid_movement_blocked', { packet })
        bot.quit('Invalid physics state')
        return
      }
      return originalWrite(packet, data)
    }
    bot.once('spawn', async () => {
      connected = true
      failures = 0
      task = 'orienting'
      if (!state.camp) {
        state.camp = { ...bot.entity.position }
        save()
      }
      log(name, 'spawn', {
        position: bot.entity.position,
        camp: state.camp,
        version: bot.version,
        models: MODELS,
      })
      await sleep(2000)
      if (connected && epoch === thisEpoch) void loop(thisEpoch)
    })
    bot.on('death', () => {
      staleRevision++
      state.recent.push({ event: 'death', at: new Date().toISOString() })
      save()
      log(name, 'death')
    })
    bot.on('kicked', (reason) =>
      log(name, 'kicked', { reason: JSON.stringify(reason).slice(0, 300) }),
    )
    bot.on('error', (error) => log(name, 'error', { error: String(error) }))
    bot.on('end', () => {
      if (epoch !== thisEpoch) return
      connected = false
      task = 'reconnecting'
      staleRevision++
      log(name, 'disconnected')
      report()
      if (!stopping) setTimeout(connect, 5000)
    })
  }
  connect()
  actors.push(() => {
    clearInterval(reportTimer)
    skills?.stop()
    bot?.quit('Controller update')
    mirror?.close()
    save()
  })
}
names.forEach((name, i) => setTimeout(() => actor(name, i), i * 3000))
log('director', 'survival_start', {
  cast: names,
  models: MODELS,
  planInterval: PLAN_INTERVAL,
  decisions: 'overlapped',
  mirrors: MIRRORS,
})
function stop() {
  if (stopping) return
  stopping = true
  clearInterval(telemetry)
  for (const close of actors) close()
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
