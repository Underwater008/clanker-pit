// The coolant spring is a round fixture. Creeper blasts may remove its source
// water or surrounding bank; restore only missing air blocks, leaving all
// occupied terrain and player construction alone.
export async function repairSpring(client, anatomy, log = () => {}) {
  if (anatomy?.spring?.length !== 4) return 0
  const cells = anatomy.spring
  const minX = Math.min(...cells.map((p) => p.x)), maxX = Math.max(...cells.map((p) => p.x))
  const minZ = Math.min(...cells.map((p) => p.z)), maxZ = Math.max(...cells.map((p) => p.z))
  const y = cells[0].y
  const pos = (x, level, z) => `${x} ${level} ${z}`
  const restore = async (x, level, z, block) => {
    const p = pos(x, level, z)
    return /^Changed the block/.test(await client.send(
      `execute if block ${p} minecraft:air run setblock ${p} minecraft:${block}`))
  }
  let repaired = 0
  for (const cell of cells)
    if (await restore(cell.x, cell.y - 1, cell.z, 'dirt')) repaired++
  for (let x = minX - 1; x <= maxX + 1; x++)
    for (let z = minZ - 1; z <= maxZ + 1; z++) {
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) continue
      if (await restore(x, y, z, 'grass_block')) repaired++
    }
  for (const cell of cells) {
    if (await restore(cell.x, cell.y, cell.z, 'water[level=0]')) {
      repaired++
      continue
    }
    const p = pos(cell.x, cell.y, cell.z)
    // Water from an earlier restored cell may already have flowed here.
    // Turn only that flowing water into a source; never replace other blocks.
    if (/^Changed the block/.test(await client.send(
      `execute if block ${p} minecraft:water unless block ${p} minecraft:water[level=0] run setblock ${p} minecraft:water[level=0]`))) repaired++
  }
  if (repaired) log('spring_repaired', { blocks: repaired, position: cells[0] })
  return repaired
}
