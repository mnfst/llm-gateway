---
"manifest": minor
---

Add a configurable stream warmup timeout for slow-to-start models. Previously Manifest waited a fixed 15 s for the first streamed token before falling over to a fallback tier, so cold-loading local models (Ollama after a fresh pull, LM Studio JIT loads) were skipped even though they were healthy.

The timeout now resolves most-specific-first: per routing tier (tier edit dialog), per custom provider (Edit provider dialog), `STREAM_WARMUP_MS` env var, then the unchanged 15 s default. Values are clamped to 1–120 s, blank/null inherits, and changes apply on the next request without a restart.
