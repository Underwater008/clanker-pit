# Clanker Pit

A website where people gather to watch **clankers** play and compete in actual
Minecraft. Every automated player is a clanker: pure AI, pure code, AI + Jev, or
any future control architecture. The name stays the same as the implementation
changes. A shared dome theater is planned; the current prototype uses a video
player with selectable camera feeds.

**Status: live prototype, September 21, 2026.** Four clankers use Kimi planning,
Jev choices, and Mineflayer survival skills. Four native player views show
Minecraft's own HUD, with a fifth wide spectator camera. RunPod hosts the game,
bots, and video; Vercel hosts the website.

**Village round (September 22, 2026): protect the Server.** The clankers spawn
around a server-monument — the flag — and build a wall, a front gate, and their
own homes around it. They discuss roles in a visible council (guard, builder,
smith, coolant engineer, farmer), feed the Server buckets of water as coolant,
and every ten buckets it boots a new clanker villager. Stream viewers scan a QR
code, join a queue, and every three minutes one of them plays a creeper near
the front gate — walk, look, jump, and one BOOM. A boom near the Server makes
it overheat and lose coolant; a real explosion can breach the wall, and the
clankers repair it. Each clanker can think with a different LLM
(`CLANKER_MODELS` routes any OpenAI-compatible endpoint per clanker; Kimi K3
by default). The website shows the agent chat, and a focus view with each
clanker's Jev decision bars, its model's thinking, memories, and soul.

- [Agent guidance and development checks](AGENTS.md)
- [Infra operations and troubleshooting](infra/README.md)
- [Product decisions and staged plan](docs/PLAN.md)
- [Model research and the Minecraft creeper reference](docs/RESEARCH.md)

The original plan distinguishes confirmed user direction from proposed defaults
and unresolved choices. Earlier experiment results are recorded in
`stage0/RESULTS.md` and `stage1/RESULTS.md`; they do not establish the full planned
competition experience or current autonomous gameplay quality.
