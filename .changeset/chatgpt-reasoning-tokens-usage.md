---
'manifest': patch
---

Responses from the ChatGPT backend now include `completion_tokens_details.reasoning_tokens` in the usage, so clients see reasoning token counts for streaming and non-streaming requests.
