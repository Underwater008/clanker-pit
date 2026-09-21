# Stage 0 results log

Record every run, success or failure. Paste verbatim provider errors — they are evidence.
Spending limit for stage 0: $____ (fill in before first paid call).

## Kimi K3 text (`kimi-text.mjs`)

| Date | Model returned | HTTP | Latency (ms) | Usage | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | kimi-k3 | 200 | 6782 | 155 prompt / 120 completion (117 reasoning) | Empty reply: `max_tokens: 120` was entirely consumed by reasoning tokens, finish_reason `length`. K3 needs headroom for reasoning + reply. |
| 2026-09-21 | kimi-k3 | 200 | 16778 | 155 prompt / 353 completion (299 reasoning) | finish_reason `stop`. In-character reply: Cinder takes Vex's beef but refuses to eat it yet, citing distrust. Good character-quality sample. |

## Kimi K3 image (`kimi-image.mjs`)

| Date | Model returned | HTTP | Latency (ms) | Image seen? | Verbatim error / notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | kimi-k3 | 500 | 1165 | n/a | Remote Wikipedia image URL (later found to 404). Error: `{"status":500,"title":"Internal Server Error","detail":"internal server error"}` |
| 2026-09-21 | kimi-k3 | 200 | 7103 | **Yes** | Inline `image_url` data URL (64x64 green PNG). Reply: "The image shows a solid green square with no other visible content, objects, or details." Correct. OpenAI-format multimodal payload works on this route. |

## Jev (`jev-choice.mjs`)

| Date | Model/version returned | HTTP | Latency (ms) | Answers | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | — | 503 | 239 | — | `no healthy upstream` (non-JSON body). Transient provider-side failure; succeeded on immediate retry. |
| 2026-09-21 | jev-1.13.0 | 200 | 1526 | `next_move`: choice `chest_b`, confidence 0.29 (P: a=0.36, b=0.64); `vex_threat`: score 2.24 "serious", confidence 0.68 | Typed answers as documented. Usage: 555 input / 55 output tokens. Alias `jev-latest` resolved to `jev-1.13.0`. |

## Minecraft bot connection

| Date | Server version | Mineflayer version | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-21 | vanilla 1.21.1 (RunPod pod `v4kirw177698qh`, RTX 3090) | mineflayer ^4.20.1 + pathfinder ^2.4.5 | **Pass** | Bot "Cinder" connected via offline mode, spawned at (7.5, -59, 9.5), completed 5/5 random waypoints in 19 s, health 20 throughout, observation + inventory reads OK. Logs: JSON events including `stage0_result ok:true`. |

## Conclusions (2026-09-21)

- **Kimi K3 text through RunPod: works.** Explicit model ID `kimi-k3` required and accepted. Latency 7–17 s for short in-character replies; K3 spends heavily on reasoning tokens (299 of 353 completion tokens), so budget `max_tokens` generously and expect multi-second responses. This latency profile supports the plan's "reflection at meaningful events, not per-tick" scheduling.
- **Kimi K3 vision through RunPod: works** with the standard OpenAI `image_url` payload using inline data URLs. Remote image URLs are untested-as-supported (our first attempt 500'd on an unreachable URL; retest with a known-good remote URL before relying on them). Screenshots-from-bot-viewpoint are viable; video input remains untested.
- **Jev: works.** Real model version `jev-1.13.0`, 1.5 s for two typed questions, low token usage. One transient 503 observed — production code needs retry/backoff around Jev calls.
- **Minecraft bot: works.** Vanilla 1.21.1 server runs on the persistent RunPod pod (`clankerpit-arena`, ~$0.22/hr); Mineflayer 4.20.1 connects and pathfinds on the first try. Version pin recorded: MC 1.21.1 / mineflayer ^4.20.1 / mineflayer-pathfinder ^2.4.5 / Node 20.
- **Infra learning:** RunPod GraphQL works with curl (Cloudflare blocks Python's default UA); bash process substitution is unreliable in our tooling — `set -a; source .env; set +a` instead. Pod lifecycle is codified in `infra/`.
- **Capture path: works (2026-09-21).** Real vanilla 1.21.1 client renders in Xvfb on the pod (Mesa; GPU unused so far — 64 vCPU make software rendering adequate at 720p30). Chain: x11grab → ffmpeg → RTMP → mediamtx LL-HLS → public RunPod proxy. Verified end to end: playlist + ~650 KB per 2 s segment (~2.6 Mbps) fetched through `https://v4kirw177698qh-8080.proxy.runpod.net/arena/index.m3u8`, and rendered frames visually confirmed (in-game, spectator mode). Learnings: `--quickPlayMultiplayer host:port` is required to auto-join (legacy `--server` is dead); camera account runs spectator + invisibility via server console.
- **Stage 0 is complete.** All items in the future-evidence checklist that stage 0 promised are now verified except video-input support for Kimi (deferred; image input suffices for the first experiments) and two-browser timing (belongs to stage 3).
