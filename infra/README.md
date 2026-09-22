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
- Capture config: 1280x720 @ 30fps, NVENC when available (otherwise x264 with
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
