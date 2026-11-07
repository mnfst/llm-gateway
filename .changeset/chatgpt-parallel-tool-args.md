---
"manifest": patch
---

Keep tool call arguments for parallel tool calls on the ChatGPT subscription provider. The backend can send a call's arguments only on `response.function_call_arguments.done`, with no deltas, so Chat Completions and Messages clients got every call with empty arguments (#3118).
