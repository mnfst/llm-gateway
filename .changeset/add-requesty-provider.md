---
'manifest': minor
---

Add Requesty as a first-class OpenAI-compatible router provider, mirroring the existing OpenRouter entry. Requesty uses `provider/model` naming and routes through `https://router.requesty.ai/v1`; models are discovered from its `/v1/models` catalog and chat traffic is proxied to `/v1/chat/completions`. Includes the provider registry entry, proxy endpoint, model fetcher config, frontend tile/icon/key-URL wiring, and docs.
