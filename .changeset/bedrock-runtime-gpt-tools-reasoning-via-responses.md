---
'manifest': patch
---

Serve Chat Completions requests with function tools and reasoning for Amazon Bedrock GPT cross-Region inference profiles through the Bedrock Runtime Responses API, which Runtime Chat Completions rejects for these models. Set `BEDROCK_RUNTIME_CHAT_VIA_RESPONSES=false` to turn it off. Sampling parameters (`temperature`, `top_p`, `stop`, `seed`, ...) are not forwarded on this route. Also read Responses stream events that carry their name only in `data.type`, and number streamed tool calls from 0 when a reasoning item comes first.

This numbering also applies to the other Responses-backed routes (OpenAI, Copilot, xAI, ChatGPT subscription and Bedrock Mantle): their streamed tool calls now start at index 0 when a reasoning item precedes them. GPT-6 Astra on Bedrock Runtime now serves Chat Completions requests with function tools instead of failing; without a `reasoning_effort` it runs at the model's default effort.
