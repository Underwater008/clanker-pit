# Research notes

Checked September 20, 2026. Public documentation was reviewed; no authenticated model requests or live Minecraft experiments were performed.

## Kimi K3 through RunPod

RunPod currently documents Kimi K3 on its managed public endpoint. The integration values are:

| Field | Documented value |
| --- | --- |
| Base URL | `https://api.runpod.ai/v2/moonshot-kimi/openai/v1` |
| Model | `kimi-k3` |
| Credential | RunPod API key, kept on the backend |
| Interface | OpenAI-compatible Chat Completions; streaming is documented |

Set the model explicitly: the shared Kimi route also serves other variants. Using the endpoint name alone is insufficient to select K3. [RunPod Kimi documentation](https://docs.runpod.io/public-endpoints/models/moonshot-kimi), [RunPod K3 product page](https://www.runpod.io/kimi-k3).

RunPod's launch guide describes K3 as understanding text, images, and video. However, the endpoint reference reviewed here documents message content as a string and does not supply an image/video request example. The guide's sample K3 client configuration also omits an image capability flag. This leaves the actual multimodal payload contract unclear; it does not establish that vision is unavailable. [RunPod launch guide](https://www.runpod.io/blog/how-to-run-kimi-k3-on-runpods-public-endpoint), [endpoint request reference](https://docs.runpod.io/public-endpoints/models/moonshot-kimi).

**Planning conclusion:** K3 is the intended character/planning backend. Treat image and video input on this specific RunPod route as integration checks. First prove text, then one image, then any supported frame sequence or clip format. If the endpoint rejects visual input, retain structured observations while resolving the route. Do not silently switch provider or provision a GPU cluster.

The managed endpoint is the starting proposal. The user already has RunPod access; deployment of a dedicated K3 cluster is outside the present scope.

## Jev through TypeSafe

TypeSafe documents three primitives: Choice, Score, and Noul, with typed results. Choice and Score include confidence. The guidance favors focused questions and explicitly states that these are not generated prose responses. [TypeSafe introduction](https://docs.typesafe.ai/introduction).

The quickstart uses `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, a supplied state, and named questions. It uses `jev-latest` in examples and shows a versioned model in the response. Record the actual model version in experiments. [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart).

**Planning conclusion:** evaluate Jev for small decisions inside a character's current plan. Supply that character's goals and relevant observations. Use game code to constrain available actions and validate results. Do not interpret confidence as proof of correctness or assume a network decision can handle every combat frame.

## Combining the models

This is our proposed architecture, rather than a capability demonstrated by the sources:

- Kimi establishes goals, interprets consequential events, and generates short character dialogue.
- Jev handles selected tactical choices using those goals and compact observations.
- A controller performs the actual Minecraft actions and immediate reactions.
- Persistent event records and memories carry consequences between decisions.

A small comparison should test whether the combined system is more interesting or responsive than Kimi with ordinary control logic alone. Use the same scenarios and observations, record actual model choices and outcomes, and measure cost and delay. Model count itself is not the success criterion.

For visual input, compare structured observations with structured observations plus occasional screenshots. Continuous video is a later experiment with separate latency, transport, and cost requirements.

## The creeper story

The closest match found is **Vals AI's GPT-6 Astra Minecraft stream**, reported on September 16, 2026, covering a Vals post from September 15. The report describes a creeper destroying valuable stored items and a bed, followed by prolonged potato farming and increasingly cautious behavior. That closely matches the user's description of an AI acquiring “PTSD” after the green monster attack. [Tom's Hardware report and embedded clip/post](https://www.tomshardware.com/tech-industry/artificial-intelligence/defeated-gpt-6-astra-model-spent-several-hours-just-farming-potatoes-after-being-blown-up-by-a-creeper-in-minecraft-openai-offering-gets-further-than-any-other-ai-system-in-141-hour-test).

Evidence boundary: the article was accessible, but the original X post and full stream were not independently inspected. Treat this as a likely identification, not confirmation of the precise clip the user remembers. The broadcaster's channel is [vals_ai on Twitch](https://www.twitch.tv/vals_ai). No conclusions about a particular agent architecture follow from the reporting.

“PTSD” is an audience interpretation of the behavior, not a demonstrated clinical condition. The relevant product idea is observable adaptation: something happens, the agent remembers it, and its subsequent choices change. That is a hypothesis to test with Clanker Pit's own event and decision records.

A character can become cautious after losing supplies, suspicious after an apparent betrayal, or protective after receiving help. These consequences can make a match compelling without scripting every action or claiming that a model literally experiences those emotions.

## Minecraft integration and viewing

[Mineflayer](https://github.com/PrismarineJS/mineflayer) documents Minecraft bot controls including movement, inventory, chests, entity attacks, and world observations. [Mineflayer Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) provides navigation. Compatibility must be checked against the selected Minecraft version; documented primitives do not by themselves establish competitive combat quality.

[Prismarine Viewer](https://github.com/PrismarineJS/prismarine-viewer) provides a browser viewer for servers and bots. It is a possible rendering candidate. We have not tested it with the chosen server, assets, camera needs, or video capture path.

The planned dome is a website environment around a shared match broadcast. A normal player and a video surface inside a 3D room can consume the same feed. The choice of broadcast capture and streaming infrastructure remains a technical experiment; a connected bot alone does not give the website encoded video.

## Future evidence checklist

- Successful K3 text response through the user's RunPod route with the explicit model ID.
- Separate image and video capability results using documented or provider-confirmed payloads.
- Successful Jev decision with recorded version, latency, and usage.
- Working bot navigation, inventory, combat, and observations without unintended hidden information.
- Measured match cost and response delays under the proposed scheduling policy.
- Genuine changes in later actions following remembered events.
- A captured Minecraft feed displayed consistently in two browser sessions.
- The same room, vote state, and match timing after switching between dome and conventional player modes.

All items above remain unverified for this project.
