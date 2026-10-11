---
'manifest': patch
---

Report Anthropic `refusal` stops as `content_filter` and `model_context_window_exceeded` stops as `length` on chat completions routes. Both were reported as `stop`, so a refused or truncated Claude reply looked like a finished turn.
