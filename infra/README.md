# Infra: the arena box

RunPod pod running the Minecraft server, bots, and (later) the capture/stream path.
Everything is driven from this directory; the only manual step is the API key.

## Prereqs

- `stage0/.env` contains `RUNPOD_API_KEY` with **Read & Write** permission
  (RunPod console → Settings → API Keys). Read-only keys can query GPU types but
  cannot create pods.
- `infra/pod_ed25519` — project SSH keypair (generated, gitignored). The public key
  is injected into the pod at creation time via the `PUBLIC_KEY` env var.

## Lifecycle

| Command | What it does |
| --- | --- |
| `./create-pod.sh` | Creates `clankerpit-arena` (RTX 3090, community cloud, 4 vCPU / 16 GB / 60 GB disk, ~$0.22/hr). Writes `pod.json`. Refuses to create twice. |
| `./pod-status.sh --wait` | Polls until RUNNING, prints the SSH command. |
| `./setup-pod.sh` | Uploads and runs `pod-setup.bash` (Java 21, Node 20, vanilla 1.21.1 server, Xvfb/ffmpeg/mediamtx), installs bot deps. Idempotent. |
| `./stop-pod.sh` | Stops compute billing; container preserved for resume. |
| `./stop-pod.sh --terminate` | Destroys the pod permanently (asks for confirmation). |

## Stage 0 bot check

After `setup-pod.sh` completes, SSH in (`./pod-status.sh` prints the command) and run:

```
cd /workspace/arena/bot && node bot-walk.mjs
```

Success = `stage0_result` with `ok: true` (bot connected, completed 5 random
waypoints, reported observations). Record the run in `stage0/RESULTS.md`.

## Layout on the pod

```
/workspace/arena/
  server/    vanilla 1.21.1, offline mode, flat arena world, tmux session 'mc'
  bot/       mineflayer stage0 scripts
  stream/    mediamtx (HLS relay, port 8080 via RunPod proxy)
  logs/      mc.log etc.
```

## Notes

- RunPod's Cloudflare blocks Python's default user agent — API calls use curl.
- SSH is on a mapped public port; get it from `./pod-status.sh`.
- Cost control: `podStop` pauses compute billing. The pod bills ~$0.22/hr while RUNNING.

## SSH versus HTTP 404s

Run `bash infra/pod-status.sh` from the repository (or `./pod-status.sh` from
this directory) to get the current direct SSH command. It queries `pod.json`'s
pod ID and resolves private port 22 to its **public TCP port**. Copy that whole
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

Port 8081 now runs `telemetry-server.py`, which serves **only** the state snapshot.
Do not replace it with `python -m http.server --directory /workspace`: that exposes
the arena `.env`, server configuration, and logs. Use SSH to inspect logs.

Offline regression checks: `python3 -B -m unittest discover -s infra -p 'test_*.py'`.

## Live stream (capture path)

Chain: Minecraft client in Xvfb (`tmux session 'cam'`) → ffmpeg x11grab (`'cap'`) →
RTMP → mediamtx (`'mtx'`) → LL-HLS on :8080 → RunPod proxy → internet.

**Watch URL (HLS):** `https://<id-from-pod.json>-8080.proxy.runpod.net/arena/index.m3u8`.
The website's stream and telemetry URLs must target the same current pod.

- Safari plays HLS natively. Chrome/Firefox need an hls.js player (the website will embed one).
- The camera account `ClankerCam` is a spectator-mode, invisible client joined via
  `--quickPlayMultiplayer 127.0.0.1:25565` (the legacy `--server/--port` args no longer auto-join).
- Capture config: 1280x720 @ 20fps, NVENC when available (otherwise x264 with
  bounded threads), ~2.5 Mbps, LL-HLS (2 s keyframes, 200 ms target parts).
- `capture/` holds: `client_setup.py` (vanilla 1.21.1 client downloader), `run-client.sh`,
  `run-stream.sh`, `options.txt` (fast graphics, no HUD-affecting mods), `mediamtx.yml`.
- Camera control today: `tmux send-keys -t mc "tp ClankerCam X Y Z yaw pitch" Enter` —
  a scripted broadcast camera is a later increment.

## tmux layout on the pod

| Session | Purpose |
| --- | --- |
| `mc` | Vanilla 1.21.1 server console (send commands with `tmux send-keys -t mc`) |
| `cam` | ClankerCam spectator client inside Xvfb :99 |
| `cap` | ffmpeg x11grab → RTMP |
| `mtx` | mediamtx HLS server |

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
most once every five minutes per bot), bounded Jev choices (at least eight
seconds apart), then verified Mineflayer actions. `survival.mjs` provides wood
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

The bots use structured local game state. Their native video is a viewer feed;
this implementation does not claim the models are playing from screenshots.

`lab-navigation.mjs` uses that same isolated lab to verify obstacle detours and
server-confirmed excavation. Normal movement may clear ordinary terrain; it
preserves player-built planks, workbenches and furnaces. Routes with no progress
are cancelled after four seconds, excluding active digging. Scouting prefers
visible wood before a blind heading. Nearby enemies and hunger trigger bounded
safety actions without waiting for a planner response.

The production round selected on 2026-09-21 is `round-20260921-native`, with a
dry cherry-grove spawn near (-113, 117, -1225). The old `world` directory and
`backups/round-20260921-native` are retained. Bootstrap preserves existing
`server.properties` so it cannot silently switch back to the old beach world.
Player POV is the website default; `?v=arena` explicitly selects the wide camera.

`lab-placement.mjs` is another isolated-server regression: the bot must place
the complete 23-block shelter from an uneven approach, with every block checked
through RCON. Placement keeps the player clear of the destination and requires
an exposed face; elevated faces use a bounded jump with a confirmed placement.
