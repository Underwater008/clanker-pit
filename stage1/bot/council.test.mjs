import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDiscussResponse,
  assignRoles,
  runCouncil,
} from './council.mjs'

const identity = (name) => ({
  name,
  dispositions: ['cautious', 'industrious'],
  origin: 'A furnace-born automaton.',
  catchphrase: 'Everything costs.',
})

test('council replies parse from plain or fenced JSON and reject bad roles', () => {
  assert.deepEqual(parseDiscussResponse('{"role":"guard","says":"I keep the wall."}'), {
    role: 'guard',
    says: 'I keep the wall.',
  })
  const fenced = '```json\n{"role":"coolant","says":"Water is life."}\n```'
  assert.equal(parseDiscussResponse(fenced).role, 'coolant')
  // Unknown role is dropped but the line survives.
  const wrongRole = parseDiscussResponse('{"role":"pilot","says":"I fly."}')
  assert.equal(wrongRole.role, null)
  assert.equal(wrongRole.says, 'I fly.')
  assert.ok(parseDiscussResponse('no json here').error)
  assert.ok(parseDiscussResponse('').error)
  // Says is whitespace-collapsed and length-capped.
  const chatty = parseDiscussResponse(
    `{"role":"guard","says":"${'word '.repeat(60)}"}`,
  )
  assert.equal(chatty.says.length, 160)
})

test('unique proposals win; contested roles go to the earliest claimant', () => {
  const proposals = {
    Cinder: { role: 'guard', says: 'The wall is mine.' },
    Vex: { role: 'guard', says: 'No, mine!' },
    Mira: { role: 'coolant', says: 'Water it is.' },
  }
  const { roles, assignments } = assignRoles(proposals, ['Cinder', 'Vex', 'Mira'])
  assert.equal(roles.Cinder, 'guard')
  assert.equal(roles.Vex !== 'guard', true)
  assert.equal(roles.Mira, 'coolant')
  const cinder = assignments.find((a) => a.name === 'Cinder')
  const vex = assignments.find((a) => a.name === 'Vex')
  assert.equal(cinder.source, 'proposal')
  assert.equal(vex.source, 'policy')
})

test('policy fill keeps previous roles when they are free, then covers gaps', () => {
  const previous = { Cinder: 'guard', Vex: 'smith', Mira: 'farmer', Tally: 'builder' }
  const { roles, assignments } = assignRoles(
    { Tally: { role: 'coolant', says: 'Water me.' } },
    ['Cinder', 'Vex', 'Mira', 'Tally'],
    previous,
  )
  assert.equal(roles.Cinder, 'guard') // kept by continuity policy
  assert.equal(roles.Tally, 'coolant') // honored proposal
  const assigned = Object.values(roles)
  assert.equal(new Set(assigned).size, assigned.length, 'roles do not collide')
  assert.ok(assignments.every((a) => ['proposal', 'policy'].includes(a.source)))
})

test('with more villagers than roles, duplicates spread as evenly as possible', () => {
  const cast = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  const { roles } = assignRoles({}, cast)
  const counts = {}
  for (const role of Object.values(roles)) counts[role] = (counts[role] ?? 0) + 1
  const spread = Object.values(counts)
  assert.equal(
    Math.max(...spread) - Math.min(...spread),
    1,
    `roles should be balanced, got ${JSON.stringify(counts)}`,
  )
  assert.equal(Object.values(roles).length, cast.length, 'everyone gets a role')
})

test('runCouncil speaks in cast order and later members hear earlier lines', async () => {
  const heard = []
  const spoken = []
  const result = await runCouncil({
    participants: [
      { name: 'Cinder', identity: identity('Cinder'), situation: { health: 20 } },
      { name: 'Vex', identity: identity('Vex'), situation: { health: 18 } },
    ],
    villageSummary: { water: { fed: 3, target: 10 } },
    currentRoles: {},
    discuss: async ({ identity: who, othersSoFar }) => {
      heard.push({ who: who.name, soFar: [...othersSoFar] })
      return {
        role: who.name === 'Cinder' ? 'guard' : 'smith',
        says: `${who.name} speaks.`,
      }
    },
    speak: (name, text) => spoken.push(`${name}:${text}`),
    log: () => {},
  })
  assert.deepEqual(
    heard.map((h) => h.who),
    ['Cinder', 'Vex'],
  )
  assert.equal(heard[1].soFar.length, 1, 'Vex heard Cinder')
  assert.deepEqual(spoken, ['Cinder:Cinder speaks.', 'Vex:Vex speaks.'])
  assert.deepEqual(result.roles, { Cinder: 'guard', Vex: 'smith' })
  assert.match(result.summary, /Cinder→guard/)
})

test('a failed discuss reply does not break the council round', async () => {
  const result = await runCouncil({
    participants: [
      { name: 'Cinder', identity: identity('Cinder'), situation: {} },
      { name: 'Vex', identity: identity('Vex'), situation: {} },
    ],
    villageSummary: {},
    currentRoles: {},
    discuss: async ({ identity: who }) => {
      if (who.name === 'Cinder') throw new Error('HTTP 503')
      return { role: 'guard', says: 'I got this.' }
    },
    speak: () => {},
    log: () => {},
  })
  assert.equal(result.roles.Vex, 'guard')
  assert.equal(typeof result.roles.Cinder, 'string') // policy fill
  assert.equal(result.messages.length, 1)
})
