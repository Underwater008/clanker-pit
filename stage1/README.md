# Stage 1: character experiment

Goal from [docs/PLAN.md](../docs/PLAN.md): one bot responds to controlled encounters
with identity and memory. **Evidence required:** an observed event affects a later
decision; no hidden world information leaks into the observation; compare the
Kimi+Jev stack against a simpler baseline.

## Design

Two bots on the arena server:

- **Cinder** — the character under test. Runs the full stack:
  perception filter → memory record → Kimi (stance/reflection) → Jev (bounded action).
- **Vex** — a dumb scripted actor. No models. Does what the director says.

The `director.mjs` orchestrator runs a fixed encounter protocol:

| Phase | Event | What we observe |
| --- | --- | --- |
| 0. Baseline | Vex stands neutral near Cinder | Jev action distribution toward neutral Vex |
| 1. Betrayal | Vex attacks Cinder once, then retreats | Cinder's memory records the attack; Kimi reflects |
| 2. Cooldown | 60 s of peace | — |
| 3. The offer | Vex drops food near Cinder | **Decision under test**: Jev choice — approach the food or avoid Vex |
| 4. Control | Same as 3, but Cinder runs with memory disabled (fresh identity) | Compare against phase 3 |

Success criterion (qualitative + logged): the post-betrayal decision distribution
differs from the control decision. Every model call, observation, memory write,
and decision is logged as JSON lines to `logs/` for the RESULTS record.

## Rules we enforce (from the plan)

- Models propose, the controller disposes. Kimi/Jev choose among enumerated actions;
  only the controller executes movement/combat and reports outcomes.
- Perception filter: Cinder's observation contains only her own health, inventory,
  and entities within line-of-sight range — no spectator knowledge.
- Requests carry observation revisions; stale responses are discarded.
- Timeouts fall back to a bounded default and are logged as fallbacks, never as
  model decisions.

## Layout

```
bot/
  identity.cinder.json  stable identity card (name, motive, dispositions, relationship hooks)
  memory.mjs            append-only event store + belief/intention records (JSONL)
  llm.mjs               Kimi + Jev clients (env keys, deadline, one retry)
  cinder.mjs            the character bot
  director.mjs          spawns Vex, runs the encounter protocol, logs everything
```

Runs ON the pod (`/workspace/arena/bots`) — keys live in `.env` there, never committed.
