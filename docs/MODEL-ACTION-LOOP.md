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
update does not count as successful digging: a server packet is required. Water
can immediately fill a mined cell, so the confirmed replacement may be air or
water.

The executor retains construction/hazard protection, reach checks, finite
coordinates, time limits and serial execution. Model requests do not block
hunger/threat safety checks. The live canary waits for a Kimi-authored program
before changing terrain, and Jev selects among its meaningful alternatives.
Waiting is exposed as `planning`. The experimental tactical mode can let Jev
choose atomic primitives while Kimi plans; its choices are labeled
`jev_primitives` and never silently become Kimi achievements. That mode is
disabled in the live controller after it repeatedly dug unrelated terrain.
Safety and swimming physics continue during planning.

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
plan also drifted away. With the current code, the hybrid loop reached grounded
dry bank in 12.2 seconds: Jev selected primitive steps while Kimi planned, then
Kimi-authored swimming steps completed the objective. This is isolated evidence,
not live village escape proof.
The [recorded isolated trial](evidence/kimi-primitive-latency-2026-09-23.json)
contains successful and failed outcomes. Long-term village task completion and
natural dialogue remain unproven.

## Live control correction

The first live canary exposed a reversed heading label: Mineflayer moves north
(-Z) at yaw zero, while our model contract called that south. The model then
authored a labeled southward swim that actually moved north into water. The
contract, local observation, and action labels now use the native convention.
An immersed clanker may mine visible permitted terrain beside water; a dry
clanker still preserves the water barrier. A dig is only credited after a
server block-change packet and a matching air or water replacement. The latter
matters because water immediately filled some mined dirt cells in the live
ravine; those were previously misreported as failed digs.

Mira's earlier tactical Jev loop confirmed many digs but made little village
progress and deepened a pit while Kimi was planning. The live controller now
lets Kimi author the short program and Jev select among its alternatives.
This is a control-authority change, not a guarantee of good planning. Judge it
by server-confirmed village work and sustained movement, not by the program
text or a short successful action.

Routine plans are now private thinking. The previous planner spoke a new task
promise on every revision, which made stalled clankers repeat the same intention
in public chat. Public clanker speech is reserved for council and reflections
on confirmed events such as blasts, coolant feeds, repaired holes, completed
homes, and new villagers. Reflections see recent chat and may choose silence.
This changes when they speak; it does not by itself establish natural dialogue.

The next live check found Kimi repeatedly starting programs with walking targets
that were inside the observed volume but lacked safe support or headroom. Each
failed at execution and caused another model request. The observation now
advertises locally feasible first actions, and every alternative must start
with one of those exact actions. Kimi still chooses the first action and may
plan subsequent steps through the full primitive contract; the executor
rechecks the world before each step. This grounds the immediate action without
encoding a route or village solution. Later steps and changing terrain can
still fail and require replanning.

A subsequent live run also showed Mira stationary for minutes while failed
flee routes repeated. The failure gate had correctly recorded zero progress,
but every other mob already in range counted as a new threat and instantly
restarted the reflex. It now remembers the nearby threat IDs at failure time;
only a genuinely new threat, contact, fresh damage, a meaningful position
change, or timeout restores the flee reflex. This lets the model attempt
another local response to a persistently unreachable mob.

Even after that fix, distant visible mobs repeatedly interrupted Mira's
Kimi-authored moves and digs before server confirmation. The primitive canary
now leaves those non-imminent threats to the model; contact within three blocks,
fresh damage, or low health still invokes the fast flee reflex. Legacy bounded-skill
clankers keep their existing safety threshold. This changes the model's
control authority, not its ability to escape or win a fight.

The legacy clankers still had a separate stall: Cinder remained in a water
pocket and repeatedly waited because its walking recovery graph requires dry
footing. Stalled, immersed clankers now receive bounded native swim inputs for
locally inspected open directions. Jev chooses among these recovery actions;
the executor confirms real displacement and blocks a no-progress choice in
the same local context. This is a general motor option, not a specific route
through the current arena. It does not imply a completed coolant delivery.


## Reconcile overlapping actions

The first live low-latency plan exposed a coordination race: at 03:26:36 UTC
Kimi selected a dig at `[-692,66,325]`; Jev finished digging that exact log
at 03:26:39; the queued Kimi step then failed at 03:26:40 because it saw air.
The controller now checks a queued dig or placement against Jev's
server-confirmed result and the current local block. If already done, it logs
`program_step_reconciled` with `source: jev_primitives` and continues the
remaining Kimi-authored steps. It never reports the Jev action as a Kimi
achievement. A failed Jev action in flight no longer cancels a newly ready
Kimi program. These are generic sequencing rules, not an escape route.


## Avoid immediate reversal and preserve valid alternatives

The live canary placed an oak log at `[-692,65,324]`, dug it 16 seconds later,
replaced it, and dug it again 20 seconds later. Jev's free-choice candidates
now omit a dig or placement that exactly reverses a verified change to the
same block within 30 seconds. Kimi can explicitly plan the reversal if a
current objective calls for it. This is a labeled controller guard against
wasted work, not model reasoning. The planner also retains a valid Kimi
alternative when another alternative targets an unobserved cell; rejected
alternatives are logged instead of discarding the whole response.
