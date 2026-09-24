# Model-authored Minecraft programs

`PRIMITIVE_CLANKERS=Mira` selects the new controller for that clanker. The default
remains the existing bounded-skill controller while the new mode is evaluated.
The selected clanker still uses its configured planner provider. No provider is
silently replaced. `MODEL_MODE=off` disables this mode rather than presenting
scripted activity as autonomous model output.

## Responsibility split

Kimi supplies one to three short alternative **executable** programs, including
block/item targets, expected block names and action order. Jev selects among
alternatives when there is a choice. A single Kimi program needs no selector
call. Failed Jev requests are labeled before using Kimi's first alternative.
No existing `build_home`, `recover_passage`, `gather_wood` or other job menu is
supplied to this planner.

`action-plan.mjs` validates the program, retains one pending model request, and
executes its steps in order. Failure cancels the remainder and returns evidence
for replanning. A repeated failed first step is rejected when the observed
situation is unchanged. Programs expire and never resume after reconnect/death.
A bounded history persists results, not an execution queue.

`primitives.mjs` implements inspect, walk to a cell, short sneaking movement,
bounded native movement keys (including swimming),
dig one block, place one block, craft a recipe, equip, toggle a simple block,
and wait. Movement cannot implicitly dig/place; digging cannot walk to its
target; crafting cannot gather missing ingredients. Block/inventory/position
updates determine outcomes. In particular, Mineflayer's optimistic local air
update does not count as successful digging: a server packet is required.

The executor retains construction/hazard protection, reach checks, finite
coordinates, time limits and serial execution. Model requests do not block
hunger/threat safety checks. While Kimi plans, Jev can select a currently feasible primitive from a bounded
local affordance set. This set contains individual movements, block operations
and craftable recipes, not task solutions. Choices are labeled `jev_primitives`;
Kimi programs take priority when ready. Selector failures remain visible and
never silently become scripted work. Waiting is exposed as `planning`.

Observations are loaded local block data, not screenshots. The bounded observed
box includes explicit unloaded cells; omitted cells within it are observed air.
No RCON data enters planning. RCON is used only by the isolated lab and operator
verification. Movement keys are bounded to ten ticks, with explicit direction
semantics. This remains structured perception, not pixel control or human-level thought.

## Evaluation

Use the isolated server on Minecraft 25566 / RCON 25576 only. The lab makes
fixture teleports, grants and controlled world changes, all explicitly labeled.
Run it sequentially with other Minecraft labs.

```sh
npm --prefix stage1/bot test
python3 -B -m unittest discover -s infra -p 'test_*.py'
node stage1/bot/lab-primitives.mjs
node stage1/bot/lab-primitives.mjs --models
```

The default lab has no model calls. `--models` uses the configured Kimi/Jev
credentials, limits programs/actions/time per task, and prints every selected
program and verified outcome. Optional `PRIMITIVE_LAB_CASES` and
`PRIMITIVE_LAB_POLICIES` select cases/policies without changing controller code.
The hand-authored baseline knows these tasks; the random baseline uses one
fixed seed and primitive candidates. Neither comparison is a broad intelligence
benchmark. Report objective completion, mutations, provider errors, action and
planning durations, including unsuccessful runs.

Cases cover rotated obstructions, crafting from materials, building a walkway,
and a world change that invalidates an in-flight plan. The last case tests
whether a new program addresses failure instead of continuing the old steps.

## Limits

The API currently handles local construction/resource work. It does not yet
expose container transfers, arbitrary fluid use, smelting, or the Server's
special coolant deposit accounting. Existing safety reflexes remain coded.
Provider latency can dominate the time between programs; extra action freedom
alone does not fix that. Keep rollout scoped and judge live task completion
before treating this controller as a replacement for the whole village.

## Recorded isolated results

The hybrid loop completed all five fixtures in 2.8-6.4 seconds using Jev's
primitive choices while Kimi was pending. Kimi is not credited for those
actions. Separate planner-only development runs completed both rotated
obstructions and crafted the pickaxe, but took 37-74 seconds. Earlier attempts
also produced schema errors and 60-second timeouts.

The hand-authored scripted baseline completed four fixtures and failed after
the unexpected world change. A no-change control verifies that the same script
reaches the full objective when its route stays open. The seeded random baseline completed none within
18 actions. These are smoke checks on small tasks, not a general model
benchmark. [Full recorded results](evidence/model-primitives-2026-09-23.json).


## Motor and visibility correction

The first live Mira rollout exposed occluded dig candidates and a walking-only
interface in a water-filled cavity. Digging now requires line of sight, and
observations include water/ground/air state. Generic native movement inputs let
the models swim or reposition without adding a scenario-specific escape skill.
Tiny physics bobbing no longer discards every pending tactical reply; crossing
a cell or changing local blocks/inventory still invalidates it. Each action is
rechecked before execution. Placement also verifies the held material first.

The optional `water` lab requires arrival on the dry bank, grounded on solid
support, with the final position checked by RCON. Merely jumping close to the
goal is insufficient. Earlier water attempts selected the wrong direction or
repeated jumping; direction semantics are now included in observations and
choice labels. These failures remain in the evidence rather than being called
successful recovery. See [motor verification](evidence/primitive-motor-2026-09-23.json).


The live check also found 19.8 KB in the objective alone, mostly repeated action
results and inventory snapshots. The planner/selector context now includes the
current inventory once and compact historical action evidence (positions,
block changes, crafted amounts, and errors). Full execution evidence remains
persisted. Historical narration/intentions are not substituted for the current
objective. Request sizes are logged so latency claims can be checked; this
change alone is not proof that the provider's timeout problem is resolved.


## Kimi planning latency and visible dig reach

The first live canary repeatedly timed out after 60 seconds despite the smaller
context. Runpod documents that Kimi K3 has always-on reasoning with a selectable
reasoning effort; short primitive programs now request `low`. This setting is
used only for Kimi K3 primitive programs. The clanker's configured model,
legacy goal planner, and other OpenAI-compatible providers keep their existing
parameters. See [Runpod's Kimi model documentation](https://docs.runpod.io/public-endpoints/models/moonshot-kimi).

An isolated Kimi-authored program now cleared a two-block obstruction and walked
through it in 22.4 seconds; the selected program arrived after 20.4 seconds.
Jev chose among Kimi's alternatives. Local perception now lists currently
feasible dig targets, including line of sight and reach, so Kimi can choose
upper/lower block order without a scripted obstacle solution. Swimming changes
in height no longer invalidate a pending plan. Walking from water has an
explicit prerequisite, and Jev receives verified failed action evidence when
selecting the next model program.

The model-only water case remained unsuccessful after five plans. Kimi planned
swimming and moved but repeatedly tried a walking leg from water; one revised
plan also drifted away. This is a measured limit, not autonomous escape proof.
The [recorded isolated trial](evidence/kimi-primitive-latency-2026-09-23.json)
contains successful and failed outcomes. Long-term village task completion and
natural dialogue remain unproven.
