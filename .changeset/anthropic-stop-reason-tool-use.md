---
'manifest': patch
---

The Anthropic Messages endpoint now reports `stop_reason: "tool_use"` when a provider returns tool calls with a `stop` (or missing) finish reason, so clients run the tools instead of ending the turn.
