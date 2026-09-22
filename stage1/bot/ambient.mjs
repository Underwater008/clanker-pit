// Persistent survival cast: Kimi plans, Jev selects feasible skills, Mineflayer executes.
//
// SCENARIO=village adds the Server-defense game: the clankers spawn around a
// server-monument "flag", discuss roles in a council (chat visible in-game and
// on the website), build a wall + front gate + homes, feed the Server buckets
// of water as coolant, and boot a new villager when the target is reached.
// Creeper booms near the Server overheat it and drain coolant.
//
// Telemetry (state.json) additionally carries the chat feed, village status,
// guest-creeper queue status, and per-clanker "brain" data (Jev options and
// probabilities, Kimi plans and thinking, memories, soul) for the focus view.
import './env.mjs'
import mineflayer from 'mineflayer'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { jevChoose } from './llm.mjs'
import { plannerFor } from './models.mjs'
import { createDecisionMaker } from './decision.mjs'
import { GOALS, installSurvival } from './survival.mjs'
import { createNativeMirror } from './native-mirror.mjs'
import {
  createVillageState,
  COUNCIL_INTERVAL,
  EXPLOSION_RADIUS,
  WALL_RADIUS,
  wallBlueprint,
  wallReinforcementBlueprint,
  gateBlueprint,
  blueprintProgress,
} from './village.mjs'
import { runCouncil } from './council.mjs'
import { Memory } from './memory.mjs'

const STATE_PATH = process.env.STATE_PATH ?? '/workspace/arena/state.json'
const DATA_DIR = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const HOST = process.env.MC_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MC_PORT ?? 25565)
const PLAN_INTERVAL = Math.max(
  90000,
  Number(process.env.PLAN_INTERVAL_MS ?? 300000),
)
const SCENARIO = process.env.SCENARIO ?? 'survival'
const MODELS = process.env.MODEL_MODE !== 'off'
const MIRRORS = process.env.NATIVE_MIRRORS !== '0'
const MIRROR_LIMIT = Number(process.env.MIRROR_LIMIT ?? 4)
const GUEST_STATE = join(DATA_DIR, 'guest.json')
const CHAT_LIMIT = 80
const STATE = {}
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(dirname(STATE_PATH), { recursive: true })

const IDENTITIES = {
  Cinder: {
    name: 'Cinder',
    dispositions: ['cautious', 'industrious', 'grudge-keeping'],
    current_goal: 'Build a reliable camp and become self-sufficient.',
    origin:
      'A furnace-born automaton who walked out of a burning workshop carrying nothing but a debt ledger.',
    catchphrase: 'Everything costs. Someone always pays.',
  },
  Vex: {
    name: 'Vex',
    dispositions: ['bold', 'opportunistic', 'restless'],
    current_goal: 'Get good tools and collect the most valuable resources.',
    origin:
      'Assembled from stolen parts by a tinkerer who vanished; remembers owning nothing, wants everything.',
    catchphrase: 'Finders, keepers. Losers, weepers.',
  },
  Mira: {
    name: 'Mira',
    dispositions: ['methodical', 'observant', 'independent'],
    current_goal: 'Establish a useful workshop and explore for supplies.',
    origin:
      'A cartographer automaton that mapped a thousand caves before it learned to build a home.',
    catchphrase: 'The map is never finished.',
  },
  Tally: {
    name: 'Tally',
    dispositions: ['social', 'showy', 'competitive'],
    current_goal: 'Build something impressive and outwork the others.',
    origin:
      'Built as a fairground scorekeeper; keeps count of everything, especially grudges.',
    catchphrase: 'Watch the scoreboard, not the clock.',
  },
}
// Souls for villagers the Server can boot. The founding cast keeps its saved
// personality; villagers get fresh ones.
const VILLAGER_SOULS = {
  Ember: {
    dispositions: ['warm', 'stubborn', 'protective'],
    origin: 'The first villager the Server booted from creek water and spite.',
    catchphrase: 'Slow burn, steady light.',
  },
  Juno: {
    dispositions: ['curious', 'chatty', 'clever'],
    origin: 'Booted with an extra cylinder of curiosity the Server regrets.',
    catchphrase: 'What does THIS button do?',
  },
  Rook: {
    dispositions: ['stoic', 'loyal', 'unmoving'],
    origin: 'Carved from bedrock by the Server during a particularly dry week.',
    catchphrase: 'The wall holds. I hold the wall.',
  },
  Wisp: {
    dispositions: ['skittish', 'quick', 'kind'],
    origin: 'Condensed from fog over the coolant spring at dawn.',
    catchphrase: 'Here, then there, then helpful.',
  },
  Patch: {
    dispositions: ['tinkerer', 'apologetic', 'handy'],
    origin: 'Booted from spare parts the others left on the workshop floor.',
    catchphrase: 'I can fix that. Probably. Eventually.',
  },
  Gadget: {
    dispositions: ['energetic', 'impatient', 'inventive'],
    origin: 'The Server sneezed while booting and produced this.',
    catchphrase: 'First, we improve it. Then we test it!',
  },
  Sprocket: {
    dispositions: ['precise', 'wry', 'diligent'],
    origin: 'Assembled entirely from parts that were almost the right size.',
    catchphrase: 'Righty-tighty keeps the village standing.',
  },
  Lumen: {
    dispositions: ['quiet', 'watchful', 'serene'],
    origin: 'Boot log says only: “let there be light on the wall”.',
    catchphrase: 'A lit village is a safe village.',
  },
}
function identityFor(name) {
  if (IDENTITIES[name]) return IDENTITIES[name]
  const soul = VILLAGER_SOULS[name]
  return {
    name,
    dispositions: soul?.dispositions ?? ['eager', 'helpful', 'green'],
    current_goal: 'Serve the village and keep the Server humming.',
    origin:
      soul?.origin ??
      `Booted by the Server from buckets of creek-water coolant.`,
    catchphrase: soul?.catchphrase ?? 'The Server provides.',
  }
}

const names = (process.env.BOT_NAMES ?? 'Cinder,Vex,Mira,Tally')
  .split(',')
  .filter(Boolean)
const log = (name, event, data = {}) =>
  console.log(
    JSON.stringify({ t: new Date().toISOString(), bot: name, event, ...data }),
  )
const actors = []
const handles = new Map() // name -> live actor handle
let stopping = false
function atomic(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}

/* ---------- shared village state ------------------------------------------ */
const villageFile = join(DATA_DIR, 'village.json')
// The controller owns the live village fields; fixture tools may write their
// own keys (roundSetup) while this process runs, so saves merge disk-fresh
// values for everything this process does not own.
const VILLAGE_OWNED_KEYS = [
  'waterFed', 'population', 'founders', 'bootedVillagers', 'fallenVillagers',
  'homeLots', 'homes', 'homeUpgrades',
  'wall', 'wallUpgrade', 'gate',
  'roles', 'processedGuestEvents', 'lastBoomAt', 'lastFedBy',
]
const village = createVillageState({
  path: villageFile,
  ownedKeys: VILLAGE_OWNED_KEYS,
})
const villageEnabled = SCENARIO === 'village' && village.exists
const scenarioGoals = Object.fromEntries(Object.entries(GOALS).filter(([goal]) =>
  villageEnabled
    ? !['build_shelter', 'improve_camp'].includes(goal)
    : !['protect_server', 'build_village', 'improve_village', 'stockpile_defense'].includes(goal),
))
if (SCENARIO === 'village' && !village.exists)
  log('director', 'village_fixture_missing', { path: villageFile })
function villageUpdate(operation, update) {
  try {
    return update()
  } catch (error) {
    log('director', error.code === 'VILLAGE_PERSIST_FAILED' ? 'village_persistence_error' : 'village_update_error', {
      operation, error: String(error).slice(0, 240), saveFailures: village.saveFailures,
    })
    return undefined
  }
}
if (villageEnabled) village.initializeCast(names)
const foundingNames = villageEnabled ? village.raw.founders : names
const friendlyNames = new Set(['ClankerCam', 'FlagSetup', ...foundingNames])
const isEnemyPlayer = (username) => {
  if (friendlyNames.has(username)) return false
  if (/^(Cam[A-Z]|View)/.test(username)) return false
  return true
}
/* One coolant basin, one pour at a time: every feed_server call runs through
 * this shared chain so pours and drinks cannot interleave between clankers. */
let basinChain = Promise.resolve()
function withBasin(fn) {
  const run = basinChain.then(fn, fn)
  basinChain = run.then(
    () => {},
    () => {},
  )
  return run
}

/* ---------- public chat feed ---------------------------------------------- */
let chatSeq = 0
const CHAT = []
function chat(kind, from, text) {
  const entry = {
    id: ++chatSeq,
    t: new Date().toISOString(),
    kind,
    from: String(from).slice(0, 32),
    text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200),
  }
  CHAT.push(entry)
  if (CHAT.length > CHAT_LIMIT) CHAT.splice(0, CHAT.length - CHAT_LIMIT)
  log('chat', entry)
  return entry
}

/* ---------- guest gateway state merge ------------------------------------- */
let guestPublic = null
function mergeGuestState() {
  if (!villageEnabled) return
  let guest
  try {
    guest = JSON.parse(readFileSync(GUEST_STATE, 'utf8'))
  } catch {
    guestPublic = null
    return
  }
  guestPublic = guest.public ?? null
  // Persisted guards handle chat and events separately: chat
  // and events share one id sequence, so a numeric in-memory cursor would
  // let a later chat id suppress an earlier, unprocessed boom event.
  for (const message of guest.chat ?? [])
    if (village.sawGuestEvent(`chat:${message.id}`))
      chat('guest', message.from, message.text)
  for (const event of guest.events ?? []) {
    const eventId = `event:${event.id}`
    if (event.type === 'boom' && villageEnabled) {
      const flag = village.flag()
      // Horizontal distance only: creeper booms happen at ground level, and
      // the plaza is graded flat, so height adds nothing but false negatives.
      const distance = flag && Number.isFinite(event.position?.x) && Number.isFinite(event.position?.z)
        ? Math.hypot(
            event.position.x - flag.x,
            event.position.z - flag.z,
          )
        : Infinity
      const nickname = event.nickname ?? 'A creeper guest'
      if (distance <= EXPLOSION_RADIUS) {
        const r = village.overheat(eventId)
        if (!r) continue
        chat(
          'system',
          'server',
          `BOOM — ${nickname} exploded ${Math.round(distance)}m from the Server core. OVERHEAT! Coolant is now ${r.after}/${village.raw.waterTarget}.`,
        )
        for (const handle of handles.values())
          if (handle.connected) handle.reflect('explosion_near_flag', {
            what: `${nickname} exploded ${Math.round(distance)}m from the Server core`,
            coolant: r.after,
          })
      } else if (village.sawGuestEvent(eventId)) {
        chat(
          'system',
          'server',
          `${nickname} exploded ${Number.isFinite(distance) ? `${Math.round(distance)}m` : 'far'} from the Server. The village holds.`,
        )
      }
    } else village.sawGuestEvent(eventId)
  }
}

/* ---------- village structure progress (one world reader) ----------------- */
function refreshVillageStructures() {
  if (!villageEnabled) return
  const reader = [...handles.values()].find(
    (h) => h.connected && h.bot?.world,
  )
  if (!reader) return
  const blockAt = (p) => {
    const b = reader.bot.blockAt(p)
    return b && b.boundingBox === 'block' && !['magma_block', 'cactus'].includes(b.name)
  }
  const flag = village.flag()
  village.setStructures({
    wall: blueprintProgress(wallBlueprint(flag), blockAt),
    wallUpgrade: blueprintProgress(wallReinforcementBlueprint(flag), blockAt),
    gate: blueprintProgress(gateBlueprint(flag), blockAt),
  })
}

/* ---------- the council --------------------------------------------------- */
let councilRunning = false
let lastCouncilAt = Date.now() - COUNCIL_INTERVAL + 90000 // first council ~90s in
async function council() {
  if (!villageEnabled || !MODELS || councilRunning || stopping) return
  const participants = [...handles.values()]
    .filter((h) => h.connected)
    .map((h) => ({
      name: h.name,
      identity: h.identity,
      discuss: h.planner.discuss, // each clanker argues with its own LLM
      situation: h.situation(),
    }))
  if (!participants.length) return
  councilRunning = true
  log('council', 'council_start', {
    bots: participants.map((p) => p.name),
    models: Object.fromEntries(
      [...handles.values()].map((h) => [h.name, h.planner.name]),
    ),
  })
  try {
    const result = await runCouncil({
      participants,
      villageSummary: village.snapshot(),
      currentRoles: currentRoles(),
      // Fallback for participants without a routed planner (none today).
      discuss: null,
      speak: (speakerName, text) => handles.get(speakerName)?.speakRaw(text),
      onMessage: ({ name, says }) => {
        chat('council', name, says)
        handles.get(name)?.memory.event('said', { to: 'council', text: says })
      },
      log: (event, data) => log('council', event, data),
    })
    if (stopping) return
    for (const { name, role, source } of result.assignments) {
      const handle = handles.get(name)
      if (!handle) continue
      handle.state.role = role
      handle.state.roleSource = source
      handle.save()
      handle.memory.event('role', { role, source })
    }
    village.setRoles(currentRoles())
    chat('system', 'council', `Roles settled — ${result.summary}.`)
  } catch (e) {
    log('council', 'council_error', { error: String(e) })
  } finally {
    councilRunning = false
    lastCouncilAt = Date.now()
  }
}
setInterval(() => {
  if (Date.now() - lastCouncilAt > COUNCIL_INTERVAL) void council()
}, 15000)

function currentRoles() {
  const roles = {}
  for (const handle of handles.values()) roles[handle.name] = handle.state.role ?? null
  return roles
}

/* ---------- actors --------------------------------------------------------- */
function actor(name, index) {
  const founder = foundingNames.includes(name)
  const identity = identityFor(name)
  // Each clanker thinks with its own routed LLM (CLANKER_MODELS in models.mjs).
  const planner = plannerFor(name)
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
    role: null,
    roleSource: null,
    homeLot: index,
    plan: {
      goal: 'build_shelter',
      intention: 'Acquire wood, craft tools and build a small shelter.',
      steps: [],
      source: 'bootstrap',
    },
    ...state,
  }
  // The shared village ledger owns lots; old per-actor files must not reclaim
  // a home already assigned to someone else after a death or restart.
  if (villageEnabled) state.homeLot = index
  if (!Object.hasOwn(scenarioGoals, state.plan?.goal)) state.plan = {
    goal: villageEnabled ? 'build_village' : 'build_shelter',
    intention: villageEnabled
      ? 'Gather materials and build the village around the Server.'
      : 'Acquire wood, craft tools and build a local shelter.',
    steps: [], source: 'bootstrap',
  }
  let bot,
    skills,
    connected = false,
    epoch = 0,
    planning = false,
    planRequest = null,
    reflectRequest = null,
    decisions = null,
    lastPlan = 0,
    failures = 0,
    task = 'connecting',
    staleRevision = 0,
    lastReflect = 0,
    permanentlyDead = false
  const brain = {
    jev: [], think: null, reflect: null, action: null,
    planner: { status: MODELS ? 'idle' : 'disabled' },
    decision: { status: MODELS ? 'idle' : 'disabled' },
  }
  const memory = new Memory(join(DATA_DIR, `memory-${name}.jsonl`))
  const mirror =
    MIRRORS && index < MIRROR_LIMIT
      ? createNativeMirror({
          port: Number(process.env.MIRROR_PORT_BASE ?? 25580) + index,
          name,
          statePath: join(DATA_DIR, `mirror-${name}.json`),
          log: (e, d) => log(name, e, d),
        })
      : null
  friendlyNames.add(name)
  const villageCtx = villageEnabled
    ? {
        flag: village.flag(),
        lotIndex: Number.isInteger(state.homeLot) ? state.homeLot : index,
        summary: () => village.snapshot(),
        isEnemyPlayer,
        // The coolant basin is a one-at-a-time ritual: serialize pour/drink
        // cycles across all clankers (they share this process) so two
        // coolant engineers can never interleave pours and double-credit.
        withBasin,
      }
    : null
  function save() {
    state.recent = state.recent.slice(-16)
    atomic(saved, state)
  }
  function say(text) {
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!line || !connected || !bot) return
    bot.chat(line)
    chat('say', name, line)
  }
  /** Speak in-game without adding a chat entry (used by the council, which
   * records its own discussion messages). */
  function speakRaw(text) {
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 160)
    if (line && connected && bot) bot.chat(line)
  }
  function situation() {
    const obs = safelyObserve()
    return {
      health: obs?.health ?? 20,
      food: obs?.food ?? 20,
      role: state.role,
      home: obs?.village?.my_home ?? null,
      village_distance: obs?.village?.distance_from_flag ?? null,
      inventory: obs?.inventory ?? [],
      current_goal: state.plan.goal,
      available_actions: obs && skills ? Object.keys(skills.candidates(obs)) : [],
    }
  }
  function safelyObserve() {
    try {
      return skills?.observation() ?? null
    } catch {
      return null
    }
  }
  async function reflect(type, data) {
    if (!MODELS || !connected || planning || reflectRequest) return
    if (Date.now() - lastReflect < 90000) return
    lastReflect = Date.now()
    const event = memory.event(type, data)
    const request = { controller: new AbortController(), epoch, revision: staleRevision }
    reflectRequest = request
    try {
      const r = await planner.reflect({
        identity,
        memoryContext: memory.recentContext(6, 3),
        event: { type, data },
        observation: safelyObserve(),
        obsRevision: request.revision,
        signal: request.controller.signal,
      })
      if (!connected || request.epoch !== epoch || request.revision !== staleRevision || request.controller.signal.aborted) return
      if (r.error) {
        log(name, 'reflect_error', { error: r.error })
        return
      }
      if (r.belief) {
        memory.belief(r.belief, [event.id])
        brain.reflect = {
          t: new Date().toISOString(),
          belief: String(r.belief).slice(0, 200),
          intention: String(r.intention ?? '').slice(0, 200),
        }
        if (r.says) say(r.says)
        save()
      }
    } catch (e) {
      log(name, 'reflect_error', { error: String(e) })
    } finally {
      if (reflectRequest === request) reflectRequest = null
    }
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
      role: state.role,
      model: { provider: planner.name, model: planner.describe.model },
      brain: {
        jev: brain.jev.slice(-8),
        think: brain.think,
        reflect: brain.reflect,
        planner: brain.planner,
        decision: brain.decision,
        action: brain.action,
      },
      soul: {
        origin: identity.origin,
        dispositions: identity.dispositions,
        motive: identity.current_goal,
        catchphrase: identity.catchphrase,
      },
      memories: {
        events: memory.events.slice(-8).map((e) => ({
          id: e.id,
          t: e.t,
          type: e.type,
          data: e.data,
        })),
        beliefs: memory.beliefs.slice(-4).map((b) => ({
          id: b.id,
          t: b.t,
          text: b.text,
        })),
      },
    }
  }
  const reportTimer = setInterval(report, 1000)
  function actorLog(event, data = {}) {
    log(name, event, data)
    if (event === 'jev_status') brain.decision = {
      ...brain.decision, ...data, error: data.error ?? null,
    }
    if (event === 'jev_decision' || event === 'fallback_decision') {
      brain.jev.push({
        t: new Date().toISOString(),
        choice: data.choice,
        source: event === 'jev_decision' ? 'jev' : 'fallback',
        confidence: data.confidence ?? null,
        durationMs: data.durationMs ?? null,
        model: data.model ?? null,
        options: data.options ?? {},
        reason: data.reason ?? null,
        error: data.error ?? null,
        requestPending: data.requestPending ?? false,
      })
      if (brain.jev.length > 12) brain.jev.splice(0, brain.jev.length - 12)
    }
    if (event === 'planner_plan')
      brain.think = {
        t: new Date().toISOString(),
        goal: data.goal,
        intention: data.intention,
        steps: data.steps,
        thinking: data.reasoning ?? '',
        model: { provider: planner.name, model: data.model ?? planner.describe.model },
      }
  }
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
    const request = { controller: new AbortController(), startedAt: Date.now() }
    planRequest = request
    brain.planner = {
      status: 'pending', requestedAt: new Date(request.startedAt).toISOString(),
      provider: planner.name, model: planner.describe.model,
    }
    log(name, 'planner_request', {
      goal: state.plan.goal,
      provider: planner.name,
      model: planner.describe.model,
    })
    try {
      const observation = skills.observation()
      const r = await planner.plan({
        identity: villageEnabled
          ? { ...identity, current_goal: `Keep the village and Server alive. Assigned role: ${state.role ?? 'unassigned'}. ${identity.current_goal}` }
          : identity,
        observation,
        memoryContext: state.recent.slice(-8),
        goals: scenarioGoals,
        actions: skills.candidates(observation),
        capabilities: skills.capabilities?.() ?? {},
        signal: request.controller.signal,
      })
      if (!connected || epoch !== thisEpoch || revision !== staleRevision || request.controller.signal.aborted) {
        if (planRequest === request) brain.planner = {
          ...brain.planner, status: 'stale', completedAt: new Date().toISOString(),
          durationMs: Date.now() - request.startedAt,
        }
        log(name, 'planner_stale')
        return
      }
      if (r.error) {
        brain.planner = {
          ...brain.planner, status: 'error', error: r.error,
          completedAt: new Date().toISOString(), durationMs: Date.now() - request.startedAt,
        }
        log(name, 'planner_fallback', { error: r.error, kept: state.plan })
        return
      }
      state.plan = { ...r, source: planner.name }
      brain.planner = {
        ...brain.planner, status: 'ready', error: null,
        completedAt: new Date().toISOString(), durationMs: Date.now() - request.startedAt,
      }
      decisions?.cancel('plan_changed')
      save()
      memory.event('plan', { goal: r.goal, intention: r.intention })
      // Route through actorLog so brain.think telemetry is populated.
      actorLog('planner_plan', r)
      if (r.says) say(r.says)
    } catch (e) {
      brain.planner = {
        ...brain.planner, status: 'error', error: String(e),
        completedAt: new Date().toISOString(), durationMs: Date.now() - request.startedAt,
      }
      log(name, 'planner_error', { error: String(e) })
    } finally {
      if (planRequest === request) {
        planning = false
        planRequest = null
      }
    }
  }
  async function loop(thisEpoch) {
    // Jev decisions are requested while the previous action runs, so the bot
    // starts its next action immediately instead of idling between cycles.
    const loopDecisions = MODELS
      ? createDecisionMaker({
          jevChoose,
          identity,
          getPlan: () => ({ ...state.plan, role: state.role ?? 'unassigned' }),
          skills,
          log: actorLog,
          sleep,
        })
      : null
    decisions = loopDecisions
    while (connected && epoch === thisEpoch && !stopping) {
      try {
        void plan()
        let urgent = skills.emergency()
        let choice, source
        if (urgent) {
          loopDecisions?.cancel('safety_reflex')
          choice = urgent
          source = 'safety_reflex'
        } else if (MODELS) {
          const d = await loopDecisions.next()
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
          loopDecisions?.cancel('safety_reflex')
          choice = urgent
          source = 'safety_reflex'
        }
        if (!choice) {
          task = 'waiting for a feasible action'
          await sleep(500)
          continue
        }
        task = choice
        report()
        const before = bot.inventory
          .items()
          .map((i) => ({ name: i.name, count: i.count }))
        const started = Date.now()
        const actionRevision = staleRevision
        brain.action = {
          action: choice, source, status: 'running',
          startedAt: new Date(started).toISOString(),
        }
        log(name, 'action_start', {
          action: choice,
          source,
          goal: state.plan.goal,
        })
        try {
          const result = await skills.execute(choice)
          if (epoch !== thisEpoch || !connected) break
          if (actionRevision !== staleRevision) throw new Error('Action interrupted before completion could be confirmed')
          // Durable village accounting must commit before success is announced.
          onActionOutcome(name, choice, result)
          failures = 0
          const outcome = {
            action: choice,
            source,
            durationMs: Date.now() - started,
            ok: true,
            result,
            at: new Date().toISOString(),
          }
          brain.action = { ...brain.action, status: 'succeeded', completedAt: outcome.at, durationMs: outcome.durationMs, result }
          state.recent.push(outcome)
          memory.event('action', { action: choice, ok: true, result })
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
          if (e.code === 'VILLAGE_PERSIST_FAILED') actorLog('village_persistence_error', {
            action: choice, error: String(e), saveFailures: village.saveFailures,
          })
          failures++
          state.cooldowns[choice] =
            Date.now() + Math.min(90000, 15000 * failures)
          const outcome = {
            action: choice,
            source,
            durationMs: Date.now() - started,
            ok: false,
            error: String(e).slice(0, 180),
            at: new Date().toISOString(),
          }
          brain.action = { ...brain.action, status: 'failed', completedAt: outcome.at, durationMs: outcome.durationMs, error: outcome.error }
          state.recent.push(outcome)
          memory.event('action', { action: choice, ok: false, error: outcome.error })
          log(name, 'action_result', outcome)
          loopDecisions?.cancel('action_failed')
          if (failures === 3) {
            lastPlan = Math.min(lastPlan, Date.now() - PLAN_INTERVAL)
            staleRevision++
            planRequest?.controller.abort()
          }
        }
        save()
        report()
        await sleep(failures ? Math.min(2000, failures * 300) : MODELS ? 100 : 600)
      } catch (e) {
        log(name, 'loop_error', { error: String(e) })
        await sleep(2000)
      }
    }
    loopDecisions?.close()
    if (decisions === loopDecisions) decisions = null
  }
  function connect() {
    if (stopping || permanentlyDead) return
    ++epoch
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      version: '1.21.1',
      username: name,
      auth: 'offline',
      hideErrors: true,
      checkTimeoutInterval: 120000,
      viewDistance: 6,
      respawn: founder,
    })
    const connection = bot
    mirror?.attach(bot)
    skills = installSurvival(bot, state, actorLog, { village: villageCtx })
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
    bot.on('spawn', async () => {
      const spawnEpoch = ++epoch
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
        scenario: SCENARIO,
        village: villageEnabled,
      })
      await sleep(2000)
      if (connected && epoch === spawnEpoch) void loop(spawnEpoch)
    })
    bot.on('death', () => {
      connected = false
      epoch++
      staleRevision++
      decisions?.cancel('death')
      skills?.stop()
      lastPlan = Math.min(lastPlan, Date.now() - PLAN_INTERVAL)
      planRequest?.controller.abort()
      reflectRequest?.controller.abort()
      state.recent.push({ event: 'death', at: new Date().toISOString() })
      memory.event('death', { position: bot?.entity?.position })
      try { save() } catch (error) {
        log(name, 'death_memory_save_error', { error: String(error) })
      }
      log(name, 'death')
      if (villageEnabled && !founder) {
        permanentlyDead = true
        task = 'permanently dead'
        clearInterval(reportTimer)
        mirror?.close()
        const retire = () => {
          try {
            const result = village.retireVillager(name)
            if (result) {
              handles.delete(name)
              friendlyNames.delete(name)
              delete STATE[name]
              chat('system', 'death', `${name} fell permanently. Their home lot is available for the next clanker.`)
              log(name, 'villager_retired', { homeLot: result.lotIndex })
            }
          } catch (error) {
            log(name, 'villager_retire_error', { error: String(error) })
            if (!stopping) setTimeout(retire, 5000)
          }
        }
        retire()
        bot.quit('Clanker permanently died')
        return
      }
      chat('system', 'death', `${name} died and will respawn.`)
    })
    bot.on('kicked', (reason) =>
      log(name, 'kicked', { reason: JSON.stringify(reason).slice(0, 300) }),
    )
    bot.on('error', (error) => log(name, 'error', { error: String(error) }))
    bot.on('end', () => {
      if (bot !== connection) return
      connected = false
      decisions?.close()
      planRequest?.controller.abort()
      reflectRequest?.controller.abort()
      if (brain.action?.status === 'running') brain.action = {
        ...brain.action, status: 'failed', error: 'Disconnected before completion was confirmed',
        completedAt: new Date().toISOString(),
      }
      task = permanentlyDead ? 'permanently dead' : 'reconnecting'
      staleRevision++
      log(name, 'disconnected')
      if (!permanentlyDead) report()
      if (!stopping && !permanentlyDead) setTimeout(connect, 5000)
    })
  }
  connect()
  handles.set(name, {
    name,
    identity,
    planner,
    state,
    memory,
    brain,
    get bot() {
      return bot
    },
    get connected() {
      return connected
    },
    save,
    say,
    speakRaw,
    situation,
    observation: safelyObserve,
    reflect,
  })
  actors.push(() => {
    clearInterval(reportTimer)
    decisions?.close()
    planRequest?.controller.abort()
    reflectRequest?.controller.abort()
    skills?.stop()
    bot?.quit('Controller update')
    mirror?.close()
    save()
  })
}

/* ---------- village event hooks ------------------------------------------- */
function onActionOutcome(name, action, result) {
  if (!villageEnabled) return
  if (result?.fedCoolant) {
    const r = village.feedCoolant(name)
    chat(
      'system',
      'server',
      `${name} fed the Server a bucket of coolant (${r.after}/${village.raw.waterTarget}).`,
    )
    handles.get(name)?.memory.event('fed_coolant', {
      coolant: r.after,
      target: village.raw.waterTarget,
    })
    if (r.after >= village.raw.waterTarget) {
      const villager = village.bootVillager()
      if (villager) {
        chat(
          'system',
          'server',
          `The Server has enough coolant. BOOTING NEW VILLAGER: ${villager}.`,
        )
        log('director', 'villager_boot', { name: villager })
        for (const handle of handles.values())
          if (handle.connected)
            handle.reflect('villager_booted', { who: villager })
        setTimeout(() => {
          if (!stopping) spawnActor(villager)
        }, 8000)
      } else {
        chat(
          'system',
          'server',
          'Coolant stores are full and the village is at capacity.',
        )
      }
    }
  }
  if (action === 'build_home' && result?.placed > 0) {
    const obs = handles.get(name)?.observation()
    if (obs?.village?.my_home) {
      village.setHome(name, obs.village.my_home)
      if (obs.village.my_home.complete)
        chat('system', 'home', `${name} finished their own home.`)
    }
  }
  if (action === 'expand_home' && result?.placed > 0) {
    const obs = handles.get(name)?.observation()
    if (obs?.village?.my_home_upgrade) {
      village.setHomeUpgrade(name, obs.village.my_home_upgrade)
      if (obs.village.my_home_upgrade.complete)
        chat('system', 'home', `${name} enlarged their home.`)
    }
  }
  if ((action === 'build_wall' || action === 'build_gate') && result?.placed > 0) {
    const obs = handles.get(name)?.observation()
    if (action === 'build_wall' && obs?.village?.wall?.complete)
      chat('system', 'village', 'The perimeter wall is complete.')
    if (action === 'build_gate' && obs?.village?.gate?.complete)
      chat('system', 'village', 'The front gate stands. The south road is held.')
  }
  if (action === 'reinforce_wall' && result?.placed > 0) {
    const obs = handles.get(name)?.observation()
    if (obs?.village?.wall_upgrade?.complete)
      chat('system', 'village', 'The perimeter wall is reinforced around the homes. The gate road remains open.')
  }
}

/* ---------- boot ----------------------------------------------------------- */
function spawnActor(name, index = village.raw.homeLots[name]) {
  if (handles.has(name)) return
  if (villageEnabled && !village.raw.population.includes(name)) return
  if (!Number.isInteger(index)) throw new Error(`Missing home lot for ${name}`)
  log('director', 'actor_spawn', { name, index })
  actor(name, index)
}
foundingNames.forEach((name, i) => setTimeout(() => spawnActor(name, villageEnabled ? undefined : i), i * 3000))
// Booted villagers persist in village.json; restore them after a controller
// restart so the village does not permanently lose its residents.
if (villageEnabled)
  for (const [i, villager] of (village.raw.bootedVillagers ?? [])
    .filter((name) => village.raw.population.includes(name)).entries())
    setTimeout(
      () => spawnActor(villager),
      (foundingNames.length + i) * 3000,
    )
if (villageEnabled)
  chat(
    'system',
    'round',
    'Round setup placed the Server monument, coolant basin + spring, starter chest, plaza world spawn and keepInventory (fixture). The village must keep the Server alive.',
  )
log('director', 'survival_start', {
  cast: foundingNames,
  models: MODELS,
  scenario: SCENARIO,
  village: villageEnabled,
  planInterval: PLAN_INTERVAL,
  decisions: 'overlapped',
  mirrors: MIRRORS,
  mirrorLimit: MIRROR_LIMIT,
})
const structureTimer = setInterval(() => villageUpdate('refresh_structures', refreshVillageStructures), 2000)
const guestTimer = setInterval(() => villageUpdate('merge_guest_events', mergeGuestState), 1000)
const telemetry = setInterval(() => {
  atomic(STATE_PATH, {
    updated: new Date().toISOString(),
    buildSha: process.env.BUILD_SHA ?? null,
    scenario: SCENARIO,
    village: villageEnabled
      ? { ...village.snapshot(), wallRadius: WALL_RADIUS }
      : null,
    chat: CHAT.slice(-60),
    guest: guestPublic,
    bots: STATE,
  })
}, 2000)
function stop() {
  if (stopping) return
  stopping = true
  clearInterval(telemetry)
  clearInterval(structureTimer)
  clearInterval(guestTimer)
  for (const close of actors) close()
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
