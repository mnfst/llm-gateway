---
'manifest': patch
---

Gemini prompts rejected up front (`promptFeedback.blockReason`, no candidates) now return a `content_filter` finish reason with usage instead of an empty `choices` array or a bare `stop`.
