# Stage 1 results: character experiment

Runs on pod `v4kirw177698qh`, vanilla 1.21.1 server, 2026-09-21.
Protocol: [README.md](README.md). Full JSONL logs: `/workspace/arena/bots/logs/` on the pod.

## The decision under test

After Vex attacks Cinder once (memory condition: Kimi reflects, stance updates;
control: no reflection, default stance), Vex drops bread near her. Jev chooses:
`approach_drop` / `retreat_from_vex` / `hold_position`.

## Pair 1 (08:10–08:15 UTC)

**Memory run** (`memory-1789978253433`)
- Betrayal recorded: `attacked by: "Vex"` (correct attribution after fix).
- Kimi reflection (13 s): belief *"An unarmed miner doesn't trade blows with a Vex —
  this debt gets paid later, with interest, once I've got iron in hand."*
  intention *"Break away from the Vex and sprint for the nearest loose item…"*
  says: *"Not today, little knife. I owe you one."*
- Jev decision with that stance: **retreat_from_vex**, confidence 0.39
  — P(approach) = **0.39**, P(retreat) = 0.60, P(hold) = 0.01.
  Outcome: Cinder walked 15 blocks away, leaving free bread on the ground.

**Control run** (`control-1789978373153`)
- No reflection; default stance *"No one here has earned trust yet."*
- Jev decision: **retreat_from_vex**, confidence 0.75
  — P(approach) = **0.06**, P(retreat) = 0.83, P(hold) = 0.11.

### Reading pair 1

Same headline choice, very different decision structure. The remembered betrayal:
- raised P(approach) from 0.06 → 0.39 (her stated scavenging intention pulled
  *toward* the bread even as distrust pulled away — a visible internal conflict),
- halved Jev's decision confidence (0.75 → 0.39).

That is the plan's evidence bar — an observed event measurably changed a later
decision — met in a qualitative sense. Pairs 2–3 below test repeatability.

## Pairs 2–3 (08:15–08:23 UTC)

| Run | Memory condition (Kimi stance) | Control (default stance) |
| --- | --- | --- |
| 1 | retreat, conf 0.39 — P(approach) 0.39 | retreat, conf 0.75 — P(approach) 0.06 |
| 2 | retreat, conf **1.00** — P(approach) 0.00 | **hold**, conf 0.34 — P(approach) 0.01 |
| 3 | retreat, conf **1.00** — P(approach) 0.00 | **hold**, conf 0.28 — P(approach) 0.00 |

Kimi reflections across runs 2–3 (consistent character, distinct phrasing):
- *"Vex struck first and is right on top of me — that's a debt written in the ledger…"*
  says: *"Noted, Vex. Every tally gets settled."*
- *"Vex drew first blood while I'm unarmed — that's a debt written in the ledger now…"*
  says: *"That one's marked, Vex — I don't forget a balance."*

## Conclusion: evidence bar met

**An observed event affects a later decision — repeatably, in character.**

- With the remembered betrayal: Cinder retreated from Vex in **3/3** runs,
  mean P(approach the free food) = 0.13, decision confidence rising to 1.00
  as the stance settled.
- Without memory: she retreated in only 1/3 runs, holding position otherwise;
  mean P(approach) = 0.02.
- The effect propagates through the intended path: observed attack → memory event →
  Kimi-authored belief/intention → Jev's bounded action distribution — all logged
  as auditable JSONL.
- Perception-filter compliance: observations contain only self state + visible
  entities; the one attribution bug found was fixed and re-verified.

Stage 1 passes. Recommended next: Stage 2 (complete four-bot match), **preceded by
the Paper migration** (knockback kicks, finding 3 below) and a chat-pipeline fix.

## Incidental findings (bugs & lore)

1. **Slime incident** (run `memory-1789977351971`): a stray slime attacked Cinder
   repeatedly; she died once. Kimi correctly inferred the attacker despite the
   perception filter reporting `unknown`: *"The 'unknown' blows are coming from that
   slime pressed against me — it already cost me one life and eight loaves of bread."*
   Emergent grudge-keeping works. Protocol now disables mob spawns and kills slimes
   repeatedly (`/kill` splits big slimes — one pass is never enough).
2. **Attribution bug (fixed):** nearest-entity scan credited *Cinder herself* as
   attacker. Kimi actually noticed the miscredit and reasoned the log was wrong —
   impressive, but the filter now excludes self.
3. **Knockback kicks:** vanilla's `invalid_player_movement` anti-cheat kicks
   mineflayer bots after combat knockback. Every. Single. Hit. Auto-reconnect
   (3 s) masks it, but real matches need a fix — **evaluate Paper with a raised
   `moved-too-quickly-multiplier`** before Stage 2.
4. **prismarine-chat crash** (vanilla 1.21.1 + mineflayer 4.20.1): echoed player
   chat crashes the process (`unknown chat format code`). `hideErrors` does not
   cover it. `says` is log-only for now; in-world dialogue deferred.
5. **Kimi reflection latency** observed: 13–53 s (reasoning-token heavy). Fine for
   event-driven reflection; confirms it can't sit in a tick loop.

## Native-view and survival upgrade, September 21, 2026

The ambient controller was separate from the character experiment: it never
called Kimi and offered Jev only five activities, with no crafting, mining or
building implementation. Its camp was hardcoded to (0, 0), far from the cast.

A live movement probe reproduced NaN outgoing coordinates immediately after an
`entity_velocity` packet. The installed Mineflayer 4.25.0 expected separate
velocity fields while its newer `minecraft-data` dependency returned a vector.
Pinned Mineflayer 4.39.0 / protocol 1.68.0 / data 3.116.0, running on Node 22,
completed repeated movement routes without this failure.

The isolated vanilla 1.21.1 lab test (`bot/lab-smoke.mjs`) used placed resource
fixtures and **scripted skill calls, without model calls**. After fixing pickup
and inventory synchronization it passed this complete chain: eight logs →
planks → sticks/workbench → wooden pickaxe → three cobblestone → stone pickaxe
→ a server-observed 23-block shelter. Vanilla confirmed the resulting inventory
and blocks. This verifies executable skills, not autonomous model intelligence.

A separate bounded live provider canary returned a `kimi-k3` plan to find trees,
collect logs and craft tools (818 total tokens in its first plan), and
`jev-1.13.0` selected and executed scouting actions. No Astra dependency was added.

The native mirror was checked with both a protocol client and the official
Minecraft client. Raw Xorg capture showed native hearts, hunger, hotbar and hand
corresponding to the bot. Reconnect testing found and fixed a partial player-info
update that previously overwrote cached profiles with undefined values.

The original starting area was a largely treeless coastline. A biome query
returned forest around (-529, -70), but the fresh world's ground there was
flooded. Biome labels alone are insufficient for selecting a safe spawn.

The user authorized a new round. The old `server/world` remains intact, with
controller/config/state backups under `backups/round-20260921-native` on the pod.
The active world is `round-20260921-native`, with the same seed, normal
difficulty and a running daylight cycle. Operators moved the cast to a dry
cherry grove, restored health/hunger for the start, and set spawn near
(-113, 117, -1225). These are round setup actions, not bot achievements.

Live Kimi/Jev decisions subsequently gathered real cherry logs and crafted
planks, sticks and workbenches. Mira placed a workbench; inventory deltas and
server block updates verified the actions. A raw capture of Mira's official
client showed the cherry grove and native hearts, hunger, hand and hotbar.

`lab-navigation.mjs` also verified a detour around an unbreakable three-high
wall and excavation through a dirt barrier in a closed corridor. RCON confirmed
both dirt blocks became air and the player reached the other side. This is a
deterministic motor-skill test, separate from live model decisions.

The pod has a 4.25-core CPU quota. Concurrent renderer startup caused tick lag
and false watchdog reconnects. Camera startup is now staggered until each
native viewer joins; heartbeat and bot timeout tolerances cover cold starts.

The extended live run confirmed stone mining, stone pickaxes and axes, plus a
crafted/placed furnace. It also exposed shelter placement failures: proximity to
a support did not ensure an exposed face, and pathfinding sometimes stopped
with the player's body overlapping the destination. Placement now keeps clear
of the target, checks exposed faces with a margin, and performs bounded jump
placement for elevated faces. The roof centre is supported early while its face
is reachable. `lab-placement.mjs`, starting on uneven terrain, completed the
entire hut: RCON verified all 23 planks and 9 remained from the 32-item fixture.
That lab uses test-only materials; the live bots gather and craft their own.
