# Recovery and model control — 2026-09-23

This document records controlled checks. The initial recovery change shipped in PR #9; deployment and longer live behavior need separate verification.

## What changed

- Persist a bounded ledger of observed attempts, positions, movement and local
  block/inventory changes. Two unchanged failures suppress that action in the
  same local context for up to three minutes. Changed terrain, inventory or
  position is re-evaluated. This is physical progress evidence, not a claim that
  the clanker completed its larger objective.
- Respect cooldowns for exploration and underground escape. Previously,
  exploration could be reinserted during cooldown, and underground escape
  returned before checking cooldowns.
- Offer up to four short, inspected walking alternatives after stalls, plus
  available safe staircase steps. Walking recovery cannot dig; stairs retain
  existing construction/hazard protections. Inspect loaded local blocks only.
- Hold with an explicit `waiting` status when no action is feasible. Do not
  count that hold as progress. Cooldowns still expire, and safety reflexes remain
  active. This cannot escape a genuinely sealed, unbreakable enclosure.
- Feed recent evidence and stored beliefs into Kimi planning, keeping beliefs
  labeled as interpretations. Stalls may request a new plan at most once per
  minute instead of waiting for the ordinary planning interval.
- Kimi can return an exact `nextAction`, consumed once and revalidated against
  current candidates. It expires 30 seconds after receipt and cannot replay on
  reconnect/restart. Other plan steps remain advisory. Jev still selects bounded
  actions between plans; pending model calls do not gate the gameplay loop.
- Attribute an accepted multi-option Kimi choice to `planner`, Jev to `jev`, and
  a forced single-option choice to policy. The planner response budget is 3,072
  tokens to reduce the previously observed truncated plans; its 60-second
  deadline remains. This does not guarantee low provider latency.

## Controlled Minecraft check

`stage1/bot/lab-progress.mjs` creates the same roofed chamber for each policy.
Actual failed exploration activates underground recovery. The clanker cannot
cut through the wooden roof. After opening a side door, two failed staircase
attempts produce four locally inspected walking choices. The models receive
the same local observations/options; RCON only creates/reset fixtures and
independently verifies the resulting server position and intact roof.

The optional model arm deliberately holds this decision point for comparison;
it does not measure concurrent production scheduling.

| Policy | Selection latency | Movement | Outside the chamber after one choice |
| --- | ---: | ---: | --- |
| Scripted first option | 0 ms | 4.12 blocks | Yes |
| Random, fixed seed 42 | 0 ms | 2.55 blocks | No |
| Kimi K3 explicit next action | 11,530 ms | 4.12 blocks | Yes |
| Jev | 205 ms | 4.12 blocks | Yes |

Walking took approximately 0.6–1.0 seconds. These are single observations, not
latency benchmarks. [Recorded choices and server evidence](evidence/recovery-comparison-2026-09-23.json).

**The scripted policy also succeeded.** This demonstrates working recovery and
real model control, not a model advantage. One fixture and one random draw do
not answer whether Kimi/Jev improve longer Minecraft play. Useful follow-up
evaluation requires varied starting conditions, multiple seeds, and objective
completion/material/survival measurements rather than movement alone.

## Reproduce

Use an isolated Minecraft 1.21.1 server on localhost **25566**, RCON **25576**,
password `clanker-lab`. Never point the lab at the production arena. It mutates
fixtures and teleports the lab clanker; none of these setup operations are
autonomous achievements. It uses no mirrors, production names or persisted
controller state.

```sh
npm --prefix stage1/bot test
node stage1/bot/lab-progress.mjs
node stage1/bot/lab-navigation.mjs
node stage1/bot/lab-underground.mjs
```

Run these Minecraft labs sequentially because they share fixture coordinates.
`lab-progress.mjs --models` makes one planner request and one Jev request
(provider clients may retry transient transport failures). It defaults to no
provider calls. Supply the intended credentials through the process environment;
the ordinary controller loader checks `stage1/.env` and root `.env`. A missing or
failed provider is reported as unavailable, never counted as model success.

The checks cover blocked retries, terrain-change invalidation, walking without
roof destruction, real server position, an honest sealed-cell hold, return to a
known obstruction, navigation detours/excavation, and bare-hand upward escape.
Unit checks cover persistence/expiry, no-op outcomes, invalid or expired planner
actions, one-time consumption across reconnects, safety priority and attribution.

## Remaining limits

The controller still uses structured local observations and coded skills,
including predefined village blueprints. It is not a screenshot/keyboard agent.
This change adds no image input or dialogue redesign. A bounded local search can
miss a distant detour, and movement can still fail to advance a larger goal.
Production stall reduction requires a separate deployed run and before/after
telemetry; local tests alone cannot establish it.

## Follow-up: access is a prerequisite

The first deployed recovery change could walk through an existing opening, but
could not create one. Live inspection found Mira inside a completed extension:
chest in front, bed behind, sidewalls and a low roof. Choosing farming again
could not solve that geometry.

The follow-up adds a local passage skill. It inspects a one-cell barrier and
clear landing, offers explicit alternatives, revalidates before each dig, waits
for server block updates, then verifies arrival. Ordinary terrain may be cleared;
a clanker may also turn its **own extension sidewall** into a doorway. Floors,
roofs, beds, containers, other homes and shared structures remain protected.
The remembered opening changes future construction targets and survives reload.
This remains a coded capability with model-selectable alternatives, not an LLM
inventing arbitrary Minecraft actions.

Two stationary navigation failures suspend travel-dependent jobs until the
local terrain/position changes. This access memory survives cooldown expiry and
inventory changes; eating, equipment and crafting remain available. The bounded
ledger retains 24 navigation failures, rather than unbounded history.

`node stage1/bot/lab-access.mjs` tests four home lots/orientations, including
server-confirmed traversal, unchanged chest contents/bed/roof, and reconnect
followed by a construction attempt. `--models` additionally asks Kimi to choose
between offered passages in the west-home fixture. Kimi selected the south
passage in 18,273 ms and traversed it; the scripted first-choice policy also
worked. This is evidence that the capability executes, **not model superiority
or human-like reasoning**. The later fixtures in that model invocation were
interrupted by an accidentally overlapping lab reset; the full scripted suite
was rerun sequentially. Evidence records keep that limitation explicit.

Run every Minecraft lab sequentially: they share the isolated server/fixtures.
Do not use a lab on production. Unit tests also cover rotated natural barriers,
protected blocks, nearby fluids/falling material, unloaded landings, and access
memory surviving crafting/time while invalidating on changed terrain.
