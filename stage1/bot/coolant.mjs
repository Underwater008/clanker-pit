// Vanilla 1.21.1 game rule: buckets filled near the remote spring become
// named coolant. Placing the water loses its item component, so moving a
// source into town does not create another coolant refinery.
import { Vec3 } from 'vec3'

export const COOLANT_ID = 'remote-spring-v1'
export function coolantSource(flag, source) {
  if (!source) return null // Existing rounds keep their rules until migrated.
  if (!['x', 'y', 'z'].every((k) => Number.isSafeInteger(source[k])))
    throw new Error('Coolant source must have integer coordinates')
  const distance = Math.hypot(source.x - flag.x, source.z - flag.z)
  if (distance < 100 || distance > 150 || source.y < -60 || source.y > 300)
    throw new Error('Coolant source must be 100–150 blocks from the Server')
  return new Vec3(source.x, source.y, source.z)
}
export function coolantCells(source) {
  const p = new Vec3(source.x, source.y, source.z)
  return [p, p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)]
}
export function isCoolantBucket(item) {
  if (item?.name !== 'water_bucket') return false
  const data = item.components?.find((c) => c.type === 'custom_data')?.data
  return data?.type === 'compound' &&
    data.value?.clanker_coolant?.type === 'string' &&
    data.value.clanker_coolant.value === COOLANT_ID
}

export function coolantPack(flag, source) {
  const p = coolantSource(flag, source)
  if (!p) throw new Error('A remote coolant source is required')
  return {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: 'Clanker Pit remote coolant spring (1.21.1)' } }),
    'data/minecraft/tags/function/load.json': JSON.stringify({ values: ['clanker_coolant:load'] }),
    'data/minecraft/tags/function/tick.json': JSON.stringify({ values: ['clanker_coolant:tick'] }),
    'data/clanker_coolant/function/load.mcfunction': 'scoreboard objectives add clanker_fill minecraft.used:minecraft.bucket\n',
    'data/clanker_coolant/function/tick.mcfunction': [
      // The server's bucket-use statistic must change. Merely carrying an
      // ordinary full bucket into the spring never refines it.
      `execute as @a[scores={clanker_fill=1..}] at @s positioned ${p.x + 0.5} ${p.y + 0.5} ${p.z + 0.5} if entity @s[distance=..5] if items entity @s weapon.mainhand minecraft:water_bucket run item modify entity @s weapon.mainhand clanker_coolant:refine`,
      'scoreboard players reset @a clanker_fill',
      '',
    ].join('\n'),
    'data/clanker_coolant/item_modifier/refine.json': JSON.stringify({
      function: 'minecraft:set_components', components: {
        'minecraft:custom_data': { clanker_coolant: COOLANT_ID },
        'minecraft:custom_name': JSON.stringify({ text: 'Cryo Coolant', color: 'aqua', italic: false }),
      },
    }),
  }
}
