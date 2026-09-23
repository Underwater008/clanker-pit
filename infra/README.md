# Infra: the arena box

RunPod runs the Minecraft server, survival controllers, native player renderers,
and capture/stream services. Vercel serves the separate website. Start with
[agent guidance](../AGENTS.md) for the source map and development checks.

`pod-bootstrap.sh` is the current full-stack startup path. It resolves GitHub
`main` to one commit (or accepts `CLANKER_SOURCE_SHA`), installs Java 21 and Node 22+, and preserves existing
`server.properties`. It starts services and may interrupt existing sessions;
do not rerun the entire bootstrap as a routine code update. Inspect the running
stack and restart only the affected components.

## Automatic creeper queue

The guest gateway fills quiet queues with 1–5 generated clanker names. Each
scheduled name becomes a real, named vanilla creeper. Human and automatic
creepers start 22 blocks outside the south gate (30 blocks from the Server),
giving defenders an approach window. `CamCreepers` is a
spectator observer used only by the match controller: loaded blocks drive
bounded path searches, and RCON applies movement impulses while vanilla
physics handles collisions and damage. No blocks are cleared for navigation.
A trapped creeper may explode to breach an obstacle. Coolant is debited only
after a server explosion packet is observed through the existing event pipeline.

Human joins go ahead of waiting clankers and preserve human FIFO order.
Existing clanker names remain behind them, and quiet queues refill gradually. An
active filler yields within eight seconds; its cooldown does not delay the
human. Fillers have a 60-second cap and use the existing three-minute spawn cadence.
Set `GUEST_FILLERS=0` to disable them. An unavailable observer disables filler
entries; the website never invents live queue names. The public queue carries
names and positions without identifying the scheduling source. A player's
camera state is returned only to their own token through `POST /guest/status`;
tokens and controller instructions stay private.

## Prereqs

- `stage0/.env` contains `RUNPOD_API_KEY` with **Read & Write** permission
  (RunPod console → Settings → API Keys). Read-only keys can query GPU types but
  cannot create pods.
- `infra/pod_ed25519` — project SSH keypair (generated, gitignored). The public key
  is injected into the pod at creation time via the `PUBLIC_KEY` env var.
- Full-stack bootstrap also needs `RUNPOD_API_KEY` (Kimi) and `TYPESAFE_API_KEY`
  (Jev) in its process environment. It writes the private bot configuration to
  `/workspace/arena/.env` only if it is absent; it preserves existing private
  configuration and does not read local `stage0/.env` automatically.

## Pod utilities and legacy setup

Run these commands from `infra/`. Creation and setup scripts below were written
for the initial stage-0 arena; their hardware and single-camera defaults are not
a description of the current pod. Query live provider state for capacity/cost.

| Command | What it does |
| --- | --- |
| `./create-pod.sh` | Legacy provisioning defaults. Creates a paid pod and writes `pod.json`; refuses to create twice. Inspect configuration before use. |
| `./pod-status.sh --wait` | Polls until RUNNING, prints the SSH command. |
| `./setup-pod.sh` | Legacy stage-0 installer (`pod-setup.bash`), including Node 20 and a single camera. Does not install the current survival stack. |
| `./stop-pod.sh` | Stops compute billing; container preserved for resume. |
| `./stop-pod.sh --terminate` | Destroys the pod permanently (asks for confirmation). |

## Historical stage-0 bot check

After `setup-pod.sh` completes, SSH in (`./pod-status.sh` prints the command) and run:

```
cd /workspace/arena/bot && node bot-walk.mjs
```

Success = `stage0_result` with `ok: true` (bot connected, completed 5 random
waypoints, reported observations). Record the run in `stage0/RESULTS.md`.

## Layout on the pod

```
/workspace/arena/
  server/     vanilla 1.21.1; server.properties selects the active world
  bots/       installed survival controller and dependencies
  bot-state/  persistent plans, camps, outcomes, and mirror heartbeats
  capture/    renderers, capture scripts, and relay configuration
  cameras/    native client profiles
  stream/     MediaMTX executable (HLS on 8080 via RunPod proxy)
  state.json  public telemetry snapshot (allowlisted on 8081)
  .env        private provider credentials
  logs/       server, controller, renderer, and capture logs
  backups/    retained world/configuration backups
```

## Notes

- RunPod's Cloudflare blocks Python's default user agent — API calls use curl.
- SSH is on a mapped public port; get it from `./pod-status.sh`.
- Cost control: stopping a pod pauses compute billing; retained storage may still
  cost money. Verify the current rate and storage policy in the provider account.

## SSH versus HTTP 404s

Run `bash infra/pod-status.sh --pod-id <id-serving-the-website>` from the repository
to get the current direct SSH command. `CLANKER_POD_ID` is also supported; without
either override it reads the ignored `pod.json`, which can still refer to an old
pod. It resolves private port 22 to its **public TCP port**. Copy that whole
command; neither port 22 on the public IP nor an HTTP proxy URL is a substitute.
The command uses the project SSH private key. The RunPod API key is used only to
discover the pod, not to authenticate SSH. Refresh the mapping after a restart.

`https://<pod-id>-8080.proxy.runpod.net` is the video service and
`https://<pod-id>-8081.proxy.runpod.net/arena/state.json` is telemetry. An HTTP
404 on these URLs does not diagnose an SSH or API-key failure.

On September 21, 2026, SSH and telemetry were healthy while video returned 404.
MediaMTX logged `no one is publishing to path`: ffmpeg was capturing tiles outside
a 1280x720 Xvfb screen. NVIDIA extraction used `-C` instead of `--target`, leaving
the Xorg module uninstalled; tiled camera startup then silently created the small
fallback screen. The corrected scripts validate display dimensions, require the
shared display for tiled clients, and fail readiness if a playlist is unavailable.

Port 8081 runs `telemetry-server.py`, which serves **only** the state snapshot
and allowlisted guest API routes, including the guest control WebSocket and
guest WHEP signaling. WebRTC media uses an ICE connection from MediaMTX;
the WHEP proxy does not expose the pod filesystem. Behind RunPod, configure
`TELEMETRY_TRUSTED_PROXY_CIDRS=100.64.1.0/24` and
`TELEMETRY_CLIENT_IP_HEADER=CF-Connecting-IP`: these were verified against the
current proxy's socket peer and overwritten client-IP header. Untrusted peers
cannot select their own rate-limit identity; default configuration trusts no
proxy headers. Refresh this configuration if the provider changes its network.
Do not replace it with `python -m http.server --directory /workspace`: that exposes
the arena `.env`, server configuration, and logs. Use SSH to inspect logs.

Offline regression checks: `python3 -B -m unittest discover -s infra -p 'test_*.py'`.

## Live stream (capture path)

Chain: official Minecraft clients on a shared GPU Xorg display → FFmpeg x11grab →
RTMP → MediaMTX (`mtx`) → LL-HLS on :8080 or guest WebRTC via WHEP on :8081.
Independent Xvfb displays are a fallback; tiled capture requires a correctly sized
shared display (3840×1440), not a single 1280×720 fallback screen.

**Watch URL (HLS):** `https://<id-from-pod.json>-8080.proxy.runpod.net/mira/index.m3u8`.
Other paths: `cinder`, `vex`, `tally`, and `arena` (wide spectator).
The website's stream and telemetry URLs must target the same current pod.

- During an active guest turn, the browser receives the newest JPEG camera
  frame over an authenticated WebSocket on port 19123. The preview drops old
  frames when a client is slow. HLS remains the fallback and public spectator
  feed; the disabled WebRTC path still needs a public ICE media route.
- The guest HLS feed uses 1 s keyframes. Other feeds use hls.js or native HLS.
- The camera account `ClankerCam` is a spectator-mode, invisible client joined via
  `--quickPlayMultiplayer 127.0.0.1:25565` (the legacy `--server/--port` args no longer auto-join).
- Capture config: 1280x720 @ 30fps, NVENC when available (otherwise x264 with
  bounded threads), ~2.5 Mbps, LL-HLS (fixed 2 s keyframes, 200 ms target parts).
  Output is resampled to a constant frame rate and adaptive scene-cut keyframes
  are disabled so missed grabs or scene changes do not shift HLS boundaries.
- `capture/` holds: `client_setup.py` (vanilla 1.21.1 client downloader), `run-client.sh`,
  `run-stream.sh`, `options.txt` (fast graphics, no HUD-affecting mods), `mediamtx.yml`.
- `spectate-loop.mjs` controls the wide camera. Contestant views follow their
  respective protocol mirrors, described below.

## tmux layout on the GPU pod

| Session | Purpose |
| --- | --- |
| `mc` | Vanilla 1.21.1 server console (send commands with `tmux send-keys -t mc`) |
| `bots` | Village survival controller, native protocol mirrors, council + brain telemetry |
| `guest` | Guest creeper gateway: viewer queue, 3-minute turns, guest mirror (25584) |
| `guestpreview` | Authenticated latest-frame guest camera on HTTP port 19123 |
| `cam{arena,cinder,vex,mira,tally,guest}` | Wide client or native-view watcher on GPU Xorg :10 |
| `cap{arena,cinder,vex,mira,tally,guest}` | FFmpeg x11grab → RTMP, one publisher per feed |
| `mtx` | mediamtx HLS server |
| `spec` | Wide spectator camera controller |
| `filesrv` | Allowlisted telemetry + guest API proxy on 8081 |

Braces above denote separate sessions, e.g. `cammira` and `capmira`. Inspect
`tmux ls` before operating; legacy/fallback launches can use different names.

Tile map on the shared 3840x1440 display (1280x720 each): `[0,0]`=mira,
`[1280,0]`=tally, `[2560,0]`=arena, `[0,720]`=cinder, `[1280,720]`=vex,
`[2560,720]`=guest. The guest feed only publishes while a viewer is actually
playing a creeper turn; `guest/index.m3u8` returning 404 between turns is normal.

## Native contestant feeds and survival controller

The four contestant views use an official vanilla 1.21.1 client connected to a
**loopback-only, read-only protocol mirror** in `stage1/bot/native-mirror.mjs`.
Mineflayer remains the only controller connected to the real server. Health,
food, hotbar, equipment, world updates and open containers are rendered by
Minecraft. Viewer inputs never reach the arena. The wide `ClankerCam` remains
a spectator. No spectator HUD mod or browser-drawn survival HUD is needed.

Mirrors: Cinder `25580`, Vex `25581`, Mira `25582`, Tally `25583`. These ports
must remain bound to `127.0.0.1`. `run-native-view.py` watches the matching
`bot-state/mirror-<name>.json` and restarts its display after bot reconnects.
The existing Xorg tiles, ffmpeg publishers and public HLS paths are unchanged.

The controller is `stage1/bot/ambient.mjs`: asynchronous Kimi plans (normally at
most once every five minutes per clanker), one bounded Jev request per clanker
(request starts at least 2.5 seconds apart), then verified Mineflayer actions.
Slow choices remain in flight while labeled fallback actions continue; expired
choices and choices invalidated by failure, death or a new plan are discarded.
`survival.mjs` provides wood
collection, crafting, mining, eating, hunting, sapling planting and a small
23-block shelter. Plans, camps and recent outcomes persist in `bot-state/`.
Fallback choices are explicitly logged and must not be called model decisions.

Use Node 22 or newer and `npm ci --ignore-scripts` with the committed lockfile.
The old Mineflayer 4.25.0 resolved newer packet definitions that encoded velocity
as a vector; it still read the obsolete `velocityX/Y/Z` fields, producing NaN
positions after knockback. Increasing server movement tolerance cannot fix NaN.
The controller now uses compatible pinned versions and rejects non-finite
outgoing movement as a final guard.

Validation:

- `cd stage1/bot && npm test` — offline protocol/cache/construction regressions.
- `python3 -B -m unittest discover -s infra -p 'test_*.py'` — infrastructure checks.
- `MODEL_MODE=off BOT_NAMES=NativeProbe ... node ambient.mjs` — explicit scripted
  canary; no model calls. Use separate `BOT_DATA_DIR` and `STATE_PATH`.
- `lab-smoke.mjs` runs only against a separate loopback test server on 25566/RCON
  25576. It builds fixtures and exercises survival skills. It is not an autonomous
  model benchmark and must never be aimed at the production arena.

### Remote coolant expedition

`coolant-setup.mjs --source x,y,z --server-dir /workspace/arena/server` adds a
small cyan spring 100–150 blocks from an existing village. Stop the controller
first. The tool rejects unfamiliar blocks, backs up the selected world and bot
state, installs a vanilla 1.21.1 datapack, and records `coolantSource` without
resetting coolant, homes, or population. The near spring continues to irrigate
the farm. Subsequent clanker starts read the persisted source.

The server refines a single bucket filled at the remote spring into **Cryo
Coolant**, identified by its `custom_data` component and aqua item name. This
is a custom game rule and cyan landmark, not a new fluid block or texture.
Only tagged buckets earn deposit credit; ordinary water can be emptied into
the drain without credit. Clankers hold one empty bucket when filling so the
rule tags the actual filled item. They navigate the expedition in short local
steps and return with the load. This does not guarantee a route across every
natural terrain: verify actual live travel after choosing a source.

`LAB_SERVER_DIR=/path/to/isolated/server node lab-coolant.mjs` verifies the
120-block round trip, ordinary-water rejection, physical deposit, iron crafting,
and armor equip on 25566/25576. `lab-native-water.mjs` exposes an isolated
mirror on 25590 for native land/submerged visual checks. Stop lab processes
and their temporary viewer afterward.

The bots use structured local game state. Their native video is a viewer feed;
this implementation does not claim the models are playing from screenshots.

`lab-navigation.mjs` uses that same isolated lab to verify obstacle detours and
server-confirmed excavation. Normal movement may clear ordinary terrain; it
preserves player-built planks, workbenches and furnaces. Routes with no progress
are cancelled after four seconds, excluding active digging. Scouting prefers
visible wood before a blind heading. Nearby enemies and hunger trigger bounded
safety actions without waiting for a planner response.

The historical survival round selected on 2026-09-21 is `round-20260921-native`, with a
dry cherry-grove spawn near (-113, 117, -1225). The old `world` directory and
`backups/round-20260921-native` are retained. Bootstrap preserves existing
`server.properties` so it cannot silently switch back to the old beach world.
FOCUS is the website default: the native POV, current plan, action outcome,
provider status and labeled decisions appear together. `?v=arena` explicitly
selects the wide camera. Public telemetry's `buildSha` identifies loaded
controller source; a fresh snapshot alone does not prove movement or progress.

The current village round uses `round-village-20260922T2040Z` (seed
`3521697135391931937`), with its Server at (-674, 66, 328). The first village
world, `round-village-20260922`, remains in `server/`. Its world, player data,
clanker state and server settings were archived after a clean shutdown at
`backups/pre-round-village-20260922T2040Z/previous-world-and-state.tar.gz`;
SHA-256: `f1db1f32c3df448cf3948b3f5c8af6e7ced0b1cbbddbe0a07522f2f6e21be882`.
The archive was verified before the switch, and that backup directory also
holds the old `bot-state/`. The earlier pre-village archive remains at
`backups/pre-village-20260922T180203Z/previous-round.tar.gz`.
`latest-round-backup.json` records the current restore inputs. Runtime
`release.json` records hashes of installed source files. Keep these backups
when updating code or restarting the controller.
The founding four clankers respawn, but a Server-booted clanker's death is final.
The vacated home lot is assigned to the next booted clanker without removing
the house blocks from the world. `home-beds.mjs` places labeled beds in the
founders' homes and sets their server respawn points beside those beds after
they join. Each run rechecks the blocks, clears only leaves that grew into
respawn tiles, and restores the spawn points. It refuses to replace other
construction.

`lab-placement.mjs` is another isolated-server regression: the bot must place
the complete 23-block shelter from an uneven approach, with every block checked
through RCON. Placement keeps the player clear of the destination and requires
an exposed face; elevated faces use a bounded jump with a confirmed placement.

`lab-village.mjs` is the village-round regression for the same isolated lab:
it fixtures a Server + spring + cauldron deposit with RCON, then verifies the whole
server-confirmed mechanics chain — infinite spring refill, `scoop_water`,
`feed_server` (deposit + drink, twice), complete wall/gate blueprints with the
gate passage open, home completion, torch placement, `mine_iron_ore` →
`smelt_iron` → `craft_bucket`, and patrol staying near the village.
`lab-village-improvements.mjs` is a shorter isolated check for wheat
tilling/planting/harvesting, a dirt-path road segment, and surface sealing of
a two-deep blast hole. Fixture items and mature wheat are explicitly granted
by RCON, so the lab proves mechanics, not autonomous resource gathering.

`lab-guest.mjs` uses the same isolated server to verify guest movement, a real
server-confirmed explosion, rejection of a repeated boom, event persistence
across gateway restart, and disconnecting a guest who leaves. Its private HTTP
gateway is on 18090 and its read-only mirror is on 25694. Run it after other
fixture-mutating labs finish, with no production guest queue involved.

`lab-harvest.mjs` verifies two concurrent clankers select separate trees and
each receives its own server-confirmed drop. `lab-escape.mjs` verifies retreat
from water continues when the server delivers damage during movement. Both
use only Minecraft 25566/RCON 25576 and require the isolated lab above.
`lab-perch.mjs` uses those same isolated ports to verify a stranded clanker
steps off an elevated crafting table onto inspected ground while preserving
the table.
`lab-home-beds.mjs` uses the isolated server to verify that a second fixture
run clears new leaves from a founder's respawn tile even with a complete marker.
`lab-spring-repair.mjs` verifies a destroyed coolant source is restored as
four source blocks with its missing bank and support, then stays unchanged on
a second pass.

## Village round: protect the Server

`SCENARIO=village` (set by pod-bootstrap) gives the controller its defense game.
`flag-setup.mjs` is the idempotent round fixture, run once before the cast: a
probe bot picks a flat dry site near world spawn, then RCON grades a village
green, raises the Server monument (obsidian base, iron core, sea lantern), digs
the coolant cauldron and a 2x2 infinite spring south of the future gate, stocks a
starter chest, and sets world spawn inside the plaza. `fixture-grant.mjs` runs
~75 s later (pod-bootstrap schedules it) and waits for Cinder to join before
handing over two starter water buckets; the grant is recorded in
`village.json` and never repeats. All of it is **labeled fixture**, never an
autonomous achievement; `village.json` in `bot-state/` is the only source the
controller and gateway trust for village geometry. Deleting
`bot-state/village.json` and rerunning `node flag-setup.mjs` re-stages the
round at a fresh site.

The cast spawns around the Server, builds the wall/gate/homes from blueprints
in `village.mjs` (standing ON the graded ground), feeds coolant (a
server-confirmed water-bucket deposit into the cauldron; the water is genuinely consumed and the
guest gateway empties the cauldron on the Server's behalf within 20 s and
restores the deposit if a blast removed it — a
labeled match-controller mechanic that doubles as the visible "server
drinks" moment), and every `FLAG_WATER_TARGET` buckets boots one new
villager from `VILLAGER_POOL` (cap `MAX_POPULATION`, restored after
controller restarts, single atomic write per boot). A creeper boom within
`FLAG_EXPLOSION_RADIUS` of the core makes the Server overheat, dropping
`FLAG_EXPLOSION_PENALTY` buckets of coolant.
The default boot cost is 40 buckets. An existing round keeps its coolant and
residents when the controller raises a lower persisted target at startup; it
never lowers an established target automatically. Public telemetry reports
the persisted target used by the live round.

The council (`council.mjs`)
runs every `COUNCIL_INTERVAL_MS`: each clanker proposes a role through its
own routed LLM and says one line in-game; assignment is deterministic policy
that honors unique proposals (logged `council_assign` with
`source: proposal|policy`).

After the first wall and homes are complete, builders can reinforce safe parts
of the wall inward on the graded village floor and extend homes one or two
blocks toward their original doorway. These are fixed, collision-checked
blueprints, not open-ended expansion: dense lots without a safe footprint stay
as built. World-confirmed upgrade progress appears in `wallUpgrade` and
`homeUpgrades` telemetry; neither action resets the original village or its
saved state.

### Per-clanker LLMs

`CLANKER_MODELS=Cinder=deepseek,Vex=openrouter` routes any OpenAI-compatible
chat endpoint to a specific clanker; declare providers with
`LLM_<ID>_BASE_URL/_API_KEY/_MODEL` in `/workspace/arena/.env`. Unlisted
clankers use `DEFAULT_LLM_PROVIDER` (kimi). A missing key or model yields a
labeled `planner_fallback` log and policy behavior — never a silent switch.

## Guest creepers (viewer participation)

`guest-gateway.mjs` (tmux `guest`) owns the human side of the game. The public
enters through the allowlisted proxy on port 8081: `GET /guest/status`,
`POST /guest/join|/guest/leave|/guest/input`, and `GET /guest/control` WebSocket.
The Python telemetry server forwards controls to the loopback-only gateway on
8090 and caps input size. WHEP is limited to the guest camera path. Every
`GUEST_TURN_EVERY_MS` (3 minutes) the queue head becomes a creeper-costumed
guest bot just outside the front gate: creeper head via RCON, real player, real
death, teleport verified before controls arm. The guest's entire control set is
move (WASD / left-half joystick), look (mouse / right-half drag), jump, and
one BOOM — boom summons an ignited creeper at the guest's position (a genuine
explosion that can breach the wall) and ends the turn. Idle guests (no input
for `GUEST_IDLE_END_MS`) free their slot; the hard cap (`GUEST_TURN_MAX_MS`,
default one cadence) ends the turn at 3 minutes so a new creeper can start
every 3 minutes even after a full-length turn.

Abuse controls: guest nicknames may never match clanker/villager/camera names
(offline-mode name collisions would kick the real player), `View*`/`Cam*`/
`FlagSetup*` prefixes are reserved, guest tokens are crypto-derived, and
joins are throttled per visitor IP at the public proxy (six per ten minutes —
the gateway only ever sees the proxy's loopback address). The queue lives
in gateway memory — a gateway restart clears it (viewers re-join; the
event-id sequence and unconsumed event buffers are restored from `guest.json`
so boom/overheat accounting survives restarts). Booms are single-attempt,
verified by a nearby server explosion packet, and never fire before the guest is confirmed
at the gate. Boom events are written to `bot-state/guest.json` and consumed
exactly once by the controller, which applies overheat penalties and
publishes queue status + guest chat in `state.json` for the website.
An uncertain explosion attempt consumes the turn and is never automatically
repeated. Late callbacks from an old guest cannot finish a newer guest's turn.
If a returning nickname has saved `Health:0`, the gateway respawns that
player before starting their camera and allows two bounded arrival retries.

The guest POV is a sixth native view: the gateway attaches a read-only mirror
on port 25584 (state file `bot-state/mirror-Guest.json`); `camguest` runs the
`run-native-view.py Guest` watcher on tile `[2560,720]` and `capguest` captures
it to the `guest` HLS path. Between turns the watcher idles with no client
running; a turn starting adds ~30-40 s of Java client startup to the guest cam.
The `guestpreview` service captures that same tile only for an authenticated
active guest browser, checks its token against the loopback-only gateway every
two seconds, and exposes only `/health` and `/frames`. It never serves files.
