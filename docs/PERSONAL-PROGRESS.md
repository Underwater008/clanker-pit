# Ground repair and personal projects

Clankers can extend a flat floor at the village's ground level across dry blast
craters. The finite apron reaches four blocks beyond each side/back wall and six
beyond the front wall. Repairs grow from a loaded, stable edge, use carried dirt
or stone, and require server-confirmed placement. They preserve structures,
occupied cells, crops, water, and the marked spring. Exterior earth gathering
cannot quarry the protected surface. All roles may repair; guard/builder fallback
priorities still emphasize repair.

Each clanker saves an individual preferred project and active need in its existing
actor state: finish/enlarge its own home, upgrade equipment through iron to diamond,
or save four diamonds and eight gold ingots. The active need rotates after five
minutes to avoid indefinite fixation. Fulfillment comes from observed home blocks
and carried/worn items, never a model's claim. Death or damage can reopen a need.
These are labeled controller needs supplied to both model observations; they are
not evidence that a model independently invented an ambition.

A feasible project step is annotated for the model. Every third successful work
step makes a personal prerequisite the first fallback option during safe downtime.
Threats, hunger, recovery and urgent coolant duties retain priority. The planner
can still choose another offered action. Public telemetry includes the saved
project, and the existing soul motive displays its current want.

Gold/diamond ore actions require a locally observed deposit and an iron-or-better
pickaxe. Gathering confirms inventory gains. Gold uses the serialized shared
furnace path; occupied input/output is left untouched. Diamond crafting considers
worn equipment to avoid duplicate armor. Gold is a treasure goal, not an upgrade
over iron armor.

Limits: home expansion uses the existing reserved connected-room blueprint.
There is no arbitrary architecture editor or dedicated deep mining expedition in
this change. A desire for diamonds cannot guarantee finding a deposit; ordinary
bounded scouting and local observations still govern access.

Validation:

```sh
npm --prefix stage1/bot test
node stage1/bot/lab-personal.mjs
```

The lab requires a separate Minecraft 1.21.1 server on loopback 25566, RCON 25576
(password `clanker-lab`). It mutates isolated fixtures, makes no model requests,
and closes its clanker connection afterward. It checks four exterior floor
placements over a deep cavity, diamond/gold pickup, gold smelting, and crafting
and wearing diamond boots. Ore, tools and crafting materials are labeled lab
fixtures; this proves executor mechanics, not autonomous resource discovery.

Verified locally on 2026-09-24: all 224 Node tests and 34 infrastructure tests passed, and the isolated lab
passed every check above. [Recorded lab evidence](evidence/personal-progress-lab-2026-09-24.json).
The lab server was stopped afterward. Deployment status is recorded separately from this isolated validation.
