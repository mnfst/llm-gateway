---
'manifest': patch
---

Fix OpenAI subscription model discovery so the newest Codex CLI models (`gpt-6-sol`, `gpt-6-luna`) appear. They shipped alongside Codex CLI `0.156.0`, and the `/backend-api/codex/models` endpoint silently returns the older model subset for older `client_version` values. Bump `CODEX_CLI_VERSION` from `0.154.0` to `0.156.1`.
