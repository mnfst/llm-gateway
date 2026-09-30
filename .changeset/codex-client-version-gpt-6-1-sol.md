---
'manifest': patch
---

Fix OpenAI subscription model discovery so `gpt-6.1-sol` appears. The `/backend-api/codex/models` endpoint returns an older model subset for older `client_version` values. Bump `CODEX_CLI_VERSION` from `0.156.1` to `0.159.2`.
