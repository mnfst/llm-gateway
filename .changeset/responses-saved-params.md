---
'manifest': patch
---

Fix saved `reasoning_effort` and `max_completion_tokens` being sent as-is on Responses API routes, where the provider rejected them and the setting never applied
