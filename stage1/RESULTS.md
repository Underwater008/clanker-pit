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

## Pair 2

_(pending)_

## Pair 3

_(pending)_

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
