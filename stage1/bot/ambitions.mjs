// Personal wants are controller-authored needs, not claims of model intent.
// Persist preferences and the active project; measure fulfillment from observations.
const tier = (name = '') => ({ iron: 3, diamond: 4, netherite: 5 })[name.split('_')[0]] ?? 0
const gear = ['pickaxe', 'sword', 'chestplate', 'leggings', 'helmet', 'boots']
const prerequisites = ['place_table', 'craft_table', 'craft_stone_pickaxe', 'craft_wooden_pickaxe',
  'place_furnace', 'craft_furnace', 'craft_sticks', 'craft_planks', 'mine_stone', 'gather_wood']
export function personalNeeds(state, obs, name, now = Date.now()) {
  const personal = state.personal ??= {
    preference: ['home', 'equipment', 'treasure'][[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 3],
    active: null, since: now, work: 0,
  }
  const items = [...obs.inventory, ...(obs.equipment ?? [])]
  const n = (name) => items.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
  const level = (suffix) => Math.max(0, ...items.filter((i) => i.name.endsWith(`_${suffix}`)).map((i) => tier(i.name)))
  const ironMissing = gear.filter((suffix) => level(suffix) < 3)
  const diamondMissing = gear.filter((suffix) => level(suffix) < 4)
  const home = obs.village?.my_home, extension = obs.village?.my_home_upgrade
  const needs = [
    { id: 'home', want: home?.complete ? 'A bigger home with a connected room' : 'A complete home of my own',
      satisfied: Boolean(home?.complete && (!extension || extension.complete)),
      actions: ['build_home', 'expand_home', 'craft_planks', 'gather_wood', 'gather_wall_earth', 'mine_stone', 'return_to_post'] },
    { id: 'equipment', want: ironMissing.length ? `Iron equipment: ${ironMissing.join(', ')}` : 'Upgrade my tools and armor to diamond',
      satisfied: diamondMissing.length === 0,
      actions: ['equip_armor', ...(ironMissing.length ? ironMissing.map((s) => `craft_iron_${s}`) : diamondMissing.map((s) => `craft_diamond_${s}`)),
        ...(ironMissing.length ? ['smelt_iron', 'mine_iron_ore'] : ['mine_diamond_ore']), ...prerequisites, 'explore'] },
    { id: 'treasure', want: 'Keep a reserve of 4 diamonds and 8 gold ingots',
      satisfied: n('diamond') >= 4 && n('gold_ingot') >= 8,
      actions: ['smelt_gold', ...(n('diamond') < 4 ? ['mine_diamond_ore'] : []), ...(n('gold_ingot') < 8 ? ['mine_gold_ore'] : []),
        'craft_iron_pickaxe', 'smelt_iron', 'mine_iron_ore', ...prerequisites, 'explore'] },
  ]
  const pending = needs.filter((need) => !need.satisfied)
  const active = pending.find((need) => need.id === personal.active)
  if (!active || now - personal.since >= 300000) {
    // Rotate after five minutes so an inaccessible resource cannot consume life forever.
    const next = active ? pending[(pending.indexOf(active) + 1) % pending.length]
      : pending.find((need) => need.id === personal.preference) ?? pending[0]
    personal.active = next?.id ?? null
    personal.since = now
  }
  personal.want = pending.find((need) => need.id === personal.active)?.want ?? 'Maintain my home and equipment'
  personal.fulfilled = needs.filter((need) => need.satisfied).map((need) => need.id)
  return { source: 'controller_needs', preference: personal.preference, active: personal.active,
    since: personal.since, needs, rule: 'Handle hunger, threats and urgent village work first. Pursue a personal project during safe downtime. Only observed blocks and inventory prove progress.' }
}

export function prioritizePersonal(options, obs, state) {
  const need = obs.personal?.needs.find((n) => n.id === obs.personal.active && !n.satisfied)
  if (!need) return options
  const next = need.actions.find((action) => Object.hasOwn(options, action))
  if (!next) return options
  const annotated = { ...options, [next]: `${options[next]} Personal project: ${need.want}.` }
  // Personal turns are opportunities, not compulsory model choices. Recovery and
  // emergency handling still run before these ordinary candidates.
  const safe = obs.health >= 16 && obs.food >= 16 && !obs.threats?.length &&
    !obs.village?.threats_near_flag?.length && !obs.village?.enemy_players?.length
  const urgentCoolant = state.role === 'coolant' && (obs.village?.water?.fed ?? 0) <= 10
  if (!safe || urgentCoolant || (state.personal?.work ?? 0) % 3 !== 2) return annotated
  return { [next]: annotated[next], ...annotated }
}
