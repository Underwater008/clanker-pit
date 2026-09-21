# Stage 0: provider and connection checks

Evidence-gathering scripts for the first build gate in [docs/PLAN.md](../docs/PLAN.md).
Nothing here is product code; everything here produces measurements we cite when
choosing architecture later.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys. `.env` is gitignored.
2. Requires Node.js 18+ (uses built-in `fetch`; no npm dependencies).

## Checks

| Script | What it proves | Run |
| --- | --- | --- |
| `kimi-text.mjs` | Kimi K3 text response through the RunPod managed endpoint, with explicit model ID, latency, and usage | `node kimi-text.mjs` |
| `kimi-image.mjs` | Whether this RunPod route accepts image input (OpenAI `image_url` payload). The docs do not specify the multimodal contract; this script reports the verbatim provider answer either way | `node kimi-image.mjs` |
| `jev-choice.mjs` | One typed Jev Choice decision, with returned model version, latency, and confidence | `node jev-choice.mjs` |

Record every run in [RESULTS.md](RESULTS.md) — success or failure. A failed image
call with the provider's exact error message is a valid, useful result.

## Minecraft bot check

The bot navigation test runs against a local Minecraft Java server and is not
scripted yet. Setup notes will live here once we pin a server version.

## Rules

- Keys come from environment variables only. Never commit `.env`.
- Use a tiny explicit spending limit; these scripts each make one call per run.
- Record the exact model ID/version returned by the provider, not the alias we sent.
