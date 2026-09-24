import test from 'node:test'
import assert from 'node:assert/strict'
import { personalNeeds, prioritizePersonal } from './ambitions.mjs'
const observation = () => ({ health: 20, food: 20, threats: [], inventory: [], equipment: [],
  village: { my_home: { complete: false }, my_home_upgrade: { complete: false }, water: { fed: 20 } } })
test('preferences and active needs survive save/reload; unsupported prose cannot fulfill them', () => {
  const state = {}, obs = observation()
  const first = personalNeeds(state, obs, 'Mira', 1000)
  const restored = JSON.parse(JSON.stringify(state))
  obs.recent_results = [{ ok: true, result: 'I built a mansion and found diamonds' }]
  const next = personalNeeds(restored, obs, 'Mira', 2000)
  assert.equal(next.preference, first.preference)
  assert.equal(next.active, first.active)
  assert.ok(next.needs.every((n) => !n.satisfied))
  assert.notEqual(personalNeeds(restored, obs, 'Mira', 302000).active, first.active)
})
test('equipped gear and actual home progress advance needs; damage revives the home need', () => {
  const obs = observation(), state = { personal: { preference: 'home', active: 'home', since: 0, work: 0 } }
  obs.village.my_home.complete = obs.village.my_home_upgrade.complete = true
  obs.equipment = ['helmet', 'chestplate', 'leggings', 'boots'].map((s) => ({ name: `iron_${s}`, count: 1 }))
  obs.inventory = ['pickaxe', 'sword'].map((s) => ({ name: `iron_${s}`, count: 1 }))
  const needs = personalNeeds(state, obs, 'Mira', 1).needs
  assert.equal(needs.find((n) => n.id === 'home').satisfied, true)
  assert.match(needs.find((n) => n.id === 'equipment').want, /diamond/)
  obs.village.my_home.complete = false
  assert.equal(personalNeeds(state, obs, 'Mira', 2).needs[0].satisfied, false)
})
test('personal turns select offered prerequisites and preserve urgent duty ordering', () => {
  const obs = observation(), state = { role: 'guard', personal: { preference: 'home', active: 'home', since: 0, work: 2 } }
  obs.personal = personalNeeds(state, obs, 'Mira', 1)
  const options = { patrol: 'Patrol', gather_wood: 'Gather wood' }
  assert.equal(Object.keys(prioritizePersonal(options, obs, state))[0], 'gather_wood')
  obs.threats = [{ name: 'creeper' }]
  assert.equal(Object.keys(prioritizePersonal(options, obs, state))[0], 'patrol')
  obs.threats = []; state.role = 'coolant'; obs.village.water.fed = 5
  assert.equal(Object.keys(prioritizePersonal(options, obs, state))[0], 'patrol')
  assert.deepEqual(prioritizePersonal({ patrol: 'Patrol' }, obs, state), { patrol: 'Patrol' })
})
