// One-time, idempotent fixture migration for a running village round.
// Stop the controller and guest gateway first; this never resets round state.
import './env.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Rcon } from 'rcon-client'
import { serverAnatomy } from './village.mjs'

const dataDir = process.env.BOT_DATA_DIR ?? '/workspace/arena/bot-state'
const { flag } = JSON.parse(readFileSync(join(dataDir, 'village.json'), 'utf8'))
if (!flag) throw new Error('Village flag is missing')
const { deposit, depositBase, core } = serverAnatomy(flag)
const rcon = await Rcon.connect({
  host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(process.env.RCON_PORT ?? 25575),
  password: process.env.RCON_PASSWORD ?? 'clanker-dev',
  timeout: 5000,
})
const coords = (p) => `${p.x} ${p.y} ${p.z}`
async function isBlock(position, block) {
  return (await rcon.send(`execute if block ${coords(position)} minecraft:${block}`)) === 'Test passed'
}
try {
  if (!await isBlock(core[0], 'iron_block') || !await isBlock(depositBase, 'stone'))
    throw new Error('Server monument or deposit base does not match the village fixture')
  if (await isBlock(deposit, 'cauldron') || await isBlock(deposit, 'water_cauldron')) {
    console.log(JSON.stringify({ event: 'deposit_already_installed', position: deposit }))
  } else {
    if (!await isBlock(deposit, 'air') && !await isBlock(deposit, 'water'))
      throw new Error(`Deposit location ${coords(deposit)} contains an unexpected block`)
    await rcon.send(`setblock ${coords(deposit)} minecraft:cauldron`)
    if (!await isBlock(deposit, 'cauldron')) throw new Error('Cauldron placement was not confirmed')
    console.log(JSON.stringify({ event: 'deposit_installed', position: deposit }))
  }
} finally {
  await rcon.end()
}
