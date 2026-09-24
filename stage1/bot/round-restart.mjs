// Labeled match-controller fixture repair, never a clanker achievement.
import { serverAnatomy } from './village.mjs'

export async function restoreServer(client, flag) {
  if (!flag || ![flag.x, flag.y, flag.z].every(Number.isSafeInteger))
    throw new Error('Invalid Server fixture coordinates')
  const a = serverAnatomy(flag)
  const blocks = [[a.base, 'obsidian'], ...a.core.map((p) => [p, 'iron_block']),
    [a.lantern, 'sea_lantern'], [a.depositBase, 'stone'], [a.deposit, 'cauldron']]
  for (const [p, block] of blocks) {
    const xyz = `${p.x} ${p.y} ${p.z}`
    // An intact deposit can still contain a clanker's poured water.
    const test = block === 'cauldron'
      ? `execute unless block ${xyz} minecraft:cauldron unless block ${xyz} minecraft:water_cauldron`
      : `execute unless block ${xyz} minecraft:${block}`
    // Blasted cells can flood. Restore only air/fluid at the six reserved
    // fixture positions; never overwrite construction or containers.
    for (const replaceable of ['air', 'water', 'lava'])
      await client.send(`${test} if block ${xyz} minecraft:${replaceable} run setblock ${xyz} minecraft:${block}`)
    const verified = block === 'cauldron'
      ? /^Test passed/.test(await client.send(`execute if block ${xyz} minecraft:cauldron`)) ||
        /^Test passed/.test(await client.send(`execute if block ${xyz} minecraft:water_cauldron`))
      : /^Test passed/.test(await client.send(`execute if block ${xyz} minecraft:${block}`))
    if (!verified) throw new Error(`Server fixture not restored at ${xyz}`)
  }
}

// One repair at a time. A crash during repair is safe: repairs are idempotent,
// and the persisted round advances only after authoritative block checks.
export function createRoundRestarter({ village, restore, now = Date.now,
  onRestart = () => {}, onError = () => {} }) {
  let busy = false, retryAt = 0
  return async function tick() {
    const round = village.raw.round
    if (busy || round?.phase !== 'restarting' || now() < Date.parse(round.restartAt) || now() < retryAt)
      return null
    busy = true
    try {
      await restore(village.flag())
      const next = village.restartRound(round.number)
      if (next) onRestart(next)
      return next
    } catch (error) {
      retryAt = now() + 5000
      onError(error)
      return null
    } finally {
      busy = false
    }
  }
}
