---
'manifest': patch
---

Replayed Anthropic tool calls whose arguments are JSON null or another non-object now send `tool_use.input` as `{}`. A missing payload was already empty; `"null"` and `"[]"` were forwarded and rejected.
