---
'manifest': patch
---

Drop the unsupported `thinking` parameter before forwarding requests to NVIDIA Nemotron models served through OpenRouter (e.g. `nvidia/nemotron-3-ultra-550b-a55b`), which validate params strictly and otherwise reject it with a 400. The strip is scoped to the Nemotron family via the bare model id, so the general OpenRouter passthrough for Gemma, DeepSeek, Kimi, etc. is unchanged.