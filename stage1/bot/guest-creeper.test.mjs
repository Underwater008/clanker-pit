import test from 'node:test'
import assert from 'node:assert/strict'
import { creeperSummon } from './guest-creeper.mjs'

test('native summons bind the queued name to one tagged UUID without disabling vanilla physics', () => {
  const command = creeperSummon('01020304-0506-4708-890a-0b0c0d0e0f10', 'MossByte', { x: 0, y: 64, z: 8 })
  assert.match(command, /^summon minecraft:creeper 0 64 8 /)
  assert.match(command, /CustomName:'\{"text":"MossByte"\}'/)
  assert.match(command, /CustomNameVisible:1b/)
  assert.match(command, /UUID:\[I;16909060,84297480,-1995830516,219025168\]/)
  assert.match(command, /cp_auto_creeper/)
  assert.doesNotMatch(command, /NoAI:1b/)
})

test('invalid names and non-finite positions cannot enter a native summon command', () => {
  const id = '01020304-0506-4708-890a-0b0c0d0e0f10'
  assert.throws(() => creeperSummon(id, "O'Brien", { x: 0, y: 64, z: 8 }))
  assert.throws(() => creeperSummon(id, 'MossByte', { x: NaN, y: 64, z: 8 }))
})
