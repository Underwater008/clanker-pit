# Working on Clanker Pit

Applies to this repository. Keep this file concise and update it when entrypoints,
deployment paths, or validation commands change. Check source and current runtime
evidence before relying on historical notes or another agent's claims.

## Product direction

- Call every automated player a **clanker** (plural: **clankers**), whether it is
  pure AI, pure code, AI + Jev, or any future control architecture. The name refers
  to the player, independent of its implementation. Use this term in product copy
  and documentation; keep technical identifiers and controller details precise.
- Build watchable clankers playing actual Minecraft: gathering, crafting,
  mining, building, and surviving, with visible progress and recovery from failure.
- The current model pair is Kimi + Jev. Other Minecraft demos are references,
  not a requirement to copy their models, hardware, or implementation.
- Each clanker may think with a **different LLM**: `CLANKER_MODELS` in
  `stage1/bot/models.mjs` routes any OpenAI-compatible endpoint per clanker
  (Kimi K3 by default). Misconfigured providers produce labeled errors,
  never a silent model switch.
- Show clanker POV with Minecraft's native hearts, hunger, and hotbar. Keep the
  wide spectator camera optional; do not recreate the survival HUD in the website.
- The **village round** (SCENARIO=village) is live product: the clankers defend
  the Server monument (the flag), hold a role council, build walls/gate/homes,
  and feed it water coolant to boot new villagers. Human viewers join a queue
  and periodically play guest creepers near the front gate (move, look, jump,
  and one boom — nothing else). The dome theater and broader competition
  features in [the plan](docs/PLAN.md) remain future product direction.
- The founding four clankers respawn. Server-booted clankers die permanently;
  their physical homes remain and the next clanker can inherit the vacant lot.
  Founders respawn beside the beds in their assigned homes.

## Current architecture and source map

| Area | Entrypoints and responsibility |
| --- | --- |
| Controller | `stage1/bot/ambient.mjs`: cast lifecycle, planning, village scenario, council, chat/brain telemetry, reconnects; `decision.mjs`: overlapped Jev scheduling |
| Gameplay | `stage1/bot/survival.mjs`: perception, feasible actions, navigation, survival and village skills (build wall/gate/home/torches, iron→bucket, coolant feeding, guard/patrol/attack); `crafting.mjs`: server-confirmed crafting |
| Village | `stage1/bot/village.mjs`: layout blueprints and economy; `coolant.mjs` + `coolant-setup.mjs`: remote spring datapack and backed-up fixture migration; `council.mjs`: role discussion + deterministic assignment; `flag-setup.mjs` + `fixture-grant.mjs`: idempotent round fixtures (labeled, RCON) |
| Home beds | `stage1/bot/home-beds.mjs`: labeled, idempotent founder bed and respawn-point fixture after the cast joins |
| Model routing | `stage1/bot/models.mjs` + `llm.mjs`: per-clanker OpenAI-compatible planners (Kimi default), Jev choice client, thinking extraction |
| Guests | `stage1/bot/guest-gateway.mjs` (match controller): viewer queue, 3-minute creeper turns, guest input (move/look/jump/boom only), guest mirror on 25584; `guest-queue.mjs` handles scheduling, `guest-boom.mjs` verifies a single summon using server explosion packets; public entry is the allowlisted `/guest/*` telemetry proxy |
| Providers | `stage1/bot/llm.mjs`: generic planner client + Kimi/Jev clients; `env.mjs`: configuration loading |
| Native POV | `stage1/bot/native-mirror.mjs`: read-only protocol mirrors (clankers 25580-25583, guest 25584); `infra/capture/run-native-view.py`: viewer lifecycle |
| Video | `infra/capture/`: official Minecraft clients, display layout, FFmpeg capture, MediaMTX HLS (six paths incl. `guest`) |
| Pod startup | `infra/pod-bootstrap.sh`; [operations guide](infra/README.md) for connection and service details |
| Telemetry | `infra/telemetry-server.py`: public state snapshot + allowlisted guest API proxy |
| Website | `web/index.html`, `web/app.js`, `web/api/state.js`, `web/vercel.json`: feeds, chat, focus view (decisions/thinking/memories/soul), QR + creeper queue, guest telemetry proxy |

RunPod hosts Minecraft, bots, native renderers, capture, and the stream relay.
Vercel hosts the existing website; it does not run the game. Kimi's inference
endpoint is a separate service from the game pod's SSH and HTTP endpoints.

The controller uses structured local game observations. Kimi plans asynchronously,
Jev chooses among bounded options, and Mineflayer executes skills and safety
reflexes. Official clients render mirrored player state for viewers; viewer input
never controls the contestants. This is not a screenshot-driven model agent.

`stage0/`, `stage1/RESULTS.md`, and the character scripts `cinder.mjs` and
`director.mjs` record earlier experiments. They are not the live controller.

## Implementation rules

- Keep movement, hunger/threat responses, and stuck recovery responsive while
  model requests are pending. Use bounded actions, timeouts, and feasible choices.
- Confirm success from authoritative game updates: actual position, changed
  blocks, and inventory. An LLM intention or resolved action promise is not proof.
- Navigation should detour or clear safe terrain and recover from stalls. Preserve
  player construction; do not solve an obstacle by endlessly jumping into it.
- Keep fallback/scripted decisions labeled. Fixtures, operator teleports, item
  grants, and lab runs are not autonomous model achievements.
- Use local observations for gameplay. Reserve RCON/world inspection for operations
  and isolated verification, rather than giving bots hidden world knowledge.
- Keep mirrors loopback-only and read-only. Preserve packet caches and player
  state when handling partial updates; the native HUD must match the contestant.
- Replay configuration fluid tags before finishing viewer configuration. Dropping
  these makes vanilla underwater fog and air bubbles disappear. Remote coolant
  uses a vanilla datapack item component; ordinary or merely renamed water buckets
  must never earn coolant credit. Keep the near spring for irrigation.
- Use Node **22+**, Java **21**, and Minecraft **1.21.1** for the current stack.
  Keep compatible protocol dependencies pinned with the committed lockfile.
  Investigate packet/schema or non-finite movement bugs instead of weakening
  server movement checks. Verify the Node executable used by the running process.

## Local checks

There is no root npm application. Run commands from the repository root:

```sh
npm --prefix stage1/bot ci --ignore-scripts
npm --prefix stage1/bot test
python3 -B -m unittest discover -s infra -p 'test_*.py'
```

Install dependencies when needed. Run checks relevant to the change; prose-only
edits need path/link review, not model calls or a server restart. For website or
HUD changes, inspect the actual rendered result at the affected viewport/feed.

Local bot configuration loads `stage1/.env`, then root `.env`, without replacing
existing environment variables. Infra utilities instead read `stage0/.env`.
On the pod, installed bots read `/workspace/arena/.env`. Check the loader before
diagnosing missing credentials; do not assume all entrypoints use the same file.

All `stage1/bot/lab-*.mjs` scripts mutate fixtures and
must only run on an isolated server (Minecraft `25566`, RCON `25576`). Never aim
them at the production arena. Keep canary `BOT_NAMES`, `BOT_DATA_DIR`, `STATE_PATH`,
and server ports separate; disable mirrors with `NATIVE_MIRRORS=0` or assign a
separate `MIRROR_PORT_BASE`. `MODEL_MODE=off` disables provider calls for scripted
checks; it is not an autonomous-model evaluation. Stop test processes afterward.

## Diagnose and deliver at the right layer

1. Inspect `git status` and relevant source first; preserve existing user changes.
   Check installed code and running processes when investigating a live issue.
2. For SSH, run `bash infra/pod-status.sh --pod-id <id-serving-the-website>` to resolve the current public TCP mapping
   for private port 22. SSH uses the project SSH key; the RunPod API key discovers
   the pod. The default ignored `infra/pod.json` can refer to an older pod; check
   it against the website's endpoint. Refresh mappings after restarts.
   An HTTP proxy URL is not an SSH host.
3. For HTTP 404s, identify the exact service and path. Trace video through native
   client → capture → RTMP publisher → MediaMTX playlist → public proxy → player.
   A missing publisher can cause HLS 404s even when SSH and API authentication work.
4. Measure model latency, action duration, server ticks, and CPU pressure separately.
   Keep capture within the pod's actual CPU quota and display bounds. Current
   capture defaults are 1280×720 at 30 fps; start renderers gradually and avoid
   repeated controller restarts that trigger all native viewers to reconnect.
5. Deploy only the affected component within the user's authorized scope. Bot and
   capture changes go to RunPod; website changes go to Vercel. `web/deploy.sh` also
   provisions project/domain wiring, so inspect it before using it for an update.
6. Bootstrap resolves GitHub `main` to one SHA (or accepts `CLANKER_SOURCE_SHA`): commit and push intended source before a rollout
   using that path. Public telemetry's `buildSha` identifies the controller release.
   Keep live repairs in versioned source. Installing a file does
   not reload a running process; plan the required restart and verify loaded code.
7. Verify the relevant result after deployment: server-confirmed gameplay, fresh
   telemetry, decoded public video/native HUD, or the canonical website. Report
   local tests, isolated lab results, and live verification separately, including
   any remaining limitation. A successful deployment alone is not gameplay proof.

## Preserve state and credentials

- Runtime state lives under `/workspace/arena/`, including `server/`, `bot-state/`,
  `state.json`, logs, and backups. Preserve the active `server.properties` and
  selected world. A code/HUD fix should not reset progress. For a requested new
  round, back up state and shut the server down cleanly before switching worlds.
- Keep `.env`, SSH private keys, pod metadata, and provider credentials out of Git
  and browser code. Do not print secret values or commands containing tokens.
- Port 8081 must serve only the allowlisted public API: the state snapshot and
  the `/guest/*` queue endpoints (body-capped, proxied to the loopback-only
  guest gateway). Never expose `/workspace` with a generic HTTP file server; it
  contains credentials and logs.
- Resolve pod addresses and provider state when needed. Do not treat old pod IDs,
  prices, screenshots, or latency measurements in notes as current facts.
