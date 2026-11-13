---
'manifest': patch
---

OpenAI-format requests routed to Gemini now forward `seed` as `generationConfig.seed` instead of silently dropping it.
