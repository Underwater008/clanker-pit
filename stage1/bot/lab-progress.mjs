// Fixed isolated ports only. RCON constructs/reset fixtures and independently
// verifies outcomes; no RCON information is sent to either model.
// node stage1/bot/lab-progress.mjs [--models] (one Kimi + one Jev request; no default cost)
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import { Rcon } from 'rcon-client'
import { Vec3 } from 'vec3'
import { installSurvival } from './survival.mjs'
import { createDecisionMaker } from './decision.mjs'

const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25576, password: 'clanker-lab' })
let bot, skills, decisions
const report = (event, data = {}) => console.log(JSON.stringify({ event, ...data }))
const setup = async (commands) => {
  for (const command of commands) await rcon.send(command)
  await sleep(700)
}
const timer = setTimeout(() => {
  console.error('PROGRESS_LAB_TIMEOUT'); skills?.stop(); bot?.quit(); rcon.end(); process.exitCode = 1
}, 240000)
const results = []
try {
  for (const policy of ['scripted', 'random', ...(process.argv.includes('--models') ? ['model', 'jev'] : [])]) {
    const state = { camp: null, recent: [], cooldowns: {}, plan: { goal: 'explore' } }
    bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, version: '1.21.1', username: 'ProgressLab', auth: 'offline' })
    skills = installSurvival(bot, state, (event, data) => report(event, data),
      { village: { flag: new Vec3(0, -57, 0), lotIndex: 0, summary: () => ({}), isEnemyPlayer: () => false } })
    await once(bot, 'spawn')
    await setup([
      'gamerule doMobSpawning false', 'time set noon', 'gamemode survival ProgressLab', 'clear ProgressLab',
      'fill -12 -61 -12 12 -50 12 air', 'fill -12 -61 -12 12 -61 12 bedrock',
      'fill -3 -60 -3 3 -58 3 bedrock', 'fill -2 -60 -2 2 -59 2 air',
      'fill -2 -58 -2 2 -58 2 oak_planks', 'tp ProgressLab 0.5 -60 0.5',
    ])
    // Actual blocked navigation activates underground recovery. The roof is
    // construction, so the old escape skill cannot safely cut a staircase.
    await assert.rejects(skills.execute('explore'), /path|goal|deadline/i)
    await assert.rejects(skills.execute('escape_upward'), /No safe local staircase/)
    assert.equal(skills.progress().stalled, true)
    // A real environment change must invalidate stale failure suppression.
    await setup(['fill 3 -60 1 3 -58 1 air', 'setblock 2 -58 1 air'])
    assert.equal(skills.progress().stalled, false)
    await assert.rejects(skills.execute('escape_upward'), /No safe local staircase/)
    await assert.rejects(skills.execute('escape_upward'), /No safe local staircase/)
    const options = skills.candidates(skills.observation())
    assert.equal(options.escape_upward, undefined)
    assert.ok(Object.keys(options).filter((key) => key.startsWith('recover_walk:')).length >= 2)
    const before = bot.entity.position.clone(), start = Date.now()
    let choice, source = policy, plannerMs = 0
    if (policy === 'model' || policy === 'jev') {
      await import('./env.mjs')
      const { plannerFor } = await import('./models.mjs')
      const planner = plannerFor('ProgressLab')
      const input = {
        identity: { name: 'ProgressLab', dispositions: ['practical'], current_goal: 'Leave the covered obstruction and resume useful exploration. Prefer an inspected clear route away from the roof.' },
        observation: skills.observation(), memoryContext: { progress: skills.progress() },
        goals: { explore: 'Get out from under the obstruction and explore' },
        actions: options, capabilities: skills.capabilities(),
      }
      const planned = policy === 'model' ? await planner.plan(input) : await (await import('./llm.mjs')).jevChoose({
        identity: input.identity, stance: state.plan, observation: input.observation,
        options, questionId: 'survival_action',
      })
      plannerMs = Date.now() - start
      if (planned.error) {
        results.push({ policy, passed: false, plannerMs, error: planned.error })
        report('MODEL_UNAVAILABLE', results.at(-1))
        skills.stop(); bot.quit(); await sleep(300)
        continue
      }
      if (policy === 'jev') {
        assert.ok(Object.hasOwn(options, planned.choice))
        choice = planned.choice
      } else {
      state.plan = { ...planned, source: planner.name, issuedAt: Date.now(), expiresAt: Date.now() + 30000 }
      decisions = createDecisionMaker({ skills, getPlan: () => state.plan, identity: {}, sleep,
        jevChoose: async () => { throw new Error('Planner instruction must execute without Jev') },
        log: report, waitCapMs: 0 })
      const decision = await decisions.next()
      assert.equal(decision.source, 'planner')
      choice = decision.choice; source = decision.source
      }
    } else if (policy === 'random') {
      // Fixed seeded draw: reproducible, not re-rolled until it wins.
      const seed = (Math.imul(42, 1664525) + 1013904223) >>> 0
      choice = Object.keys(options)[Math.floor(seed / 2 ** 32 * Object.keys(options).length)]
    } else choice = Object.keys(options)[0]
    const result = await skills.execute(choice, { source })
    assert.ok(before.distanceTo(bot.entity.position) >= 0.75)
    const serverPosition = await rcon.send('data get entity ProgressLab Pos')
    assert.match(serverPosition, /ProgressLab has the following entity data/)
    const coordinates = [...serverPosition.matchAll(/(-?\d+(?:\.\d+)?)d/g)].map((match) => Number(match[1]))
    assert.equal(coordinates.length, 3)
    assert.ok(bot.entity.position.distanceTo(new Vec3(...coordinates)) < 0.3, 'Client outcome must agree with the server')
    assert.match(await rcon.send('execute if block 0 -58 0 oak_planks'), /^Test passed/)
    const outside = bot.entity.position.x >= 3.3
    results.push({ policy, choice, plannerMs, actionMs: Date.now() - start - plannerMs,
      moved: result.moved, outside, serverPosition, passed: true })
    report('POLICY_RESULT', results.at(-1))
    if (outside) {
      // Fixture teleport only: returning to an unchanged known obstruction
      // must expose alternatives even though the preceding action moved.
      await setup(['tp ProgressLab 0.5 -60 0.5'])
      assert.equal(skills.progress().stalled, false)
      assert.ok(Object.keys(skills.candidates(skills.observation())).some((key) => key.startsWith('recover_walk:')))
      report('RETURN_TO_BLOCKED_PLACE_PASS', { policy })
    }
    // A genuinely sealed one-cell trap must hold honestly without inventing
    // movement or damaging the structure. Cooldown cannot re-add explore.
    await setup(['fill -1 -60 -1 1 -58 1 bedrock', 'fill 0 -60 0 0 -59 0 air', 'tp ProgressLab 0.5 -60 0.5'])
    state.cooldowns.explore = Date.now() + 90000
    state.cooldowns.escape_upward = Date.now() + 90000
    assert.deepEqual(Object.keys(skills.candidates(skills.observation())), ['wait_for_change'])
    const held = bot.entity.position.clone(), count = state.progressMemory.attempts.length
    assert.equal((await skills.execute('wait_for_change')).waiting, true)
    assert.ok(held.distanceTo(bot.entity.position) < 0.1)
    assert.equal(state.progressMemory.attempts.length, count)
    report('HONEST_HOLD_PASS', { policy })
    decisions?.close(); decisions = null; skills.stop(); bot.quit(); await sleep(300)
  }
  report('LAB_PROGRESS_COMPLETE', { results, limitation: 'One fixture and one seeded random draw. Does not establish general model superiority.' })
} finally {
  clearTimeout(timer); decisions?.close(); skills?.stop(); bot?.quit(); await rcon.end()
}
