---
'manifest': patch
---

Drop Anthropic provider-defined tools (server tools, `mcp_toolset`, and schema-less typed tools) when an Anthropic Messages request is forwarded to a provider that cannot execute them. Counting only happens for routing/scoring; the outbound cross-protocol body no longer declares a tool no one can run. Native Anthropic routes are unchanged.
