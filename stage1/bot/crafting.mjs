// Server-confirmed 1.21.1 crafting. Never synthesize output items in local inventory.
// A stale stateId asks vanilla to return its authoritative window after each click.
import { once } from 'node:events'

export async function craftConfirmed(bot, recipe, count = 1, table = null) {
  let window = bot.inventory
  if (recipe.requiresTable) {
    if (!table) throw new Error('A workbench is required')
    const opened = once(bot, 'windowOpen', {
      signal: AbortSignal.timeout(8000),
    })
    await bot.activateBlock(table)
    ;[window] = await opened
  }
  const width = recipe.requiresTable ? 3 : 2
  async function click(slot, mouseButton = 0) {
    const done = once(bot, `setWindowItems:${window.id}`, {
      signal: AbortSignal.timeout(8000),
    })
    bot._client.write('window_click', {
      windowId: window.id,
      stateId: -1,
      slot,
      mouseButton,
      mode: 0,
      changedSlots: [],
      cursorItem: { itemCount: 0, components: [], removeComponents: [] },
    })
    await done
  }
  async function putCursorAway() {
    while (window.selectedItem) {
      const held = window.selectedItem
      let target = null
      for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
        const i = window.slots[s]
        if (i && i.type === held.type && i.count + held.count <= i.stackSize) {
          target = s
          break
        }
      }
      target ??= window.firstEmptySlotRange(
        window.inventoryStart,
        window.inventoryEnd,
      )
      if (target === null) throw new Error('Inventory full while crafting')
      await click(target)
    }
  }
  try {
    await bot._syncWindow(window)
    await putCursorAway()
    for (let s = 1; s <= width * width; s++)
      if (window.slots[s]) {
        await click(s)
        await putCursorAway()
      }
    for (let iteration = 0; iteration < count; iteration++) {
      const placements = []
      if (recipe.inShape)
        for (let y = 0; y < recipe.inShape.length; y++)
          for (let x = 0; x < recipe.inShape[y].length; x++) {
            const i = recipe.inShape[y][x]
            if (i.id !== -1)
              placements.push({ slot: 1 + x + y * width, item: i })
          }
      for (const ingredient of recipe.ingredients ?? []) {
        const slot = Array.from(
          { length: width * width },
          (_, i) => i + 1,
        ).find((s) => !placements.some((p) => p.slot === s))
        placements.push({ slot, item: ingredient })
      }
      for (const { slot, item } of placements) {
        const source = window.findInventoryItem(item.id, item.metadata)
        if (!source) throw new Error(`Missing crafting ingredient ${item.id}`)
        await click(source.slot)
        await click(slot, 1)
        await putCursorAway()
      }
      if (window.slots[0]?.type !== recipe.result.id)
        throw new Error('Server did not produce the expected crafting result')
      await click(0)
      await putCursorAway()
    }
  } finally {
    if (window !== bot.inventory) {
      await bot.closeWindow(window)
      await bot._syncWindow(bot.inventory)
    }
  }
}
