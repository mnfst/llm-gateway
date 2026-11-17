---
'manifest': patch
---

Pass empty completions through instead of failing them. A provider reply that finished normally with no text and no tool call (Chat Completions with `finish_reason: "stop"`, or a completed ChatGPT subscription response) now reaches the caller as a normal 200. Manifest no longer turns it into a 502 or moves to the next fallback.
