---
'manifest': patch
---

Serve Chat Completions and Messages requests for Amazon Bedrock GPT cross-Region inference profiles (such as `us.openai.gpt-6-luna`) through the Bedrock Runtime Responses API. Runtime Chat Completions rejects function tools combined with reasoning on these models.

Also read Responses stream events that carry their name only as `type` in the data (no `event:` line), as Bedrock Runtime sends them. Without this, streamed Chat Completions for these models came back empty.
