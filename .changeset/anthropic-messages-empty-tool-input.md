---
'manifest': patch
---

Anthropic Messages responses whose tool arguments are JSON null or another non-object now send `tool_use.input` as `{}`, including streamed `input_json_delta` chunks. A missing payload was already empty; `"null"` and `"[]"` were forwarded and rejected.
