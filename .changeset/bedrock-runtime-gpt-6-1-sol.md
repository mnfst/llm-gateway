---
'manifest': patch
---

Bedrock discovery now lists the `us.` and `global.` Runtime inference profiles of GPT-6.1 Sol. By default, Chat Completions requests with function tools to these profiles are served through Runtime Responses, which drops sampling parameters such as `temperature` and `top_p`, as for the other Bedrock Runtime GPT profiles. Set `BEDROCK_RUNTIME_CHAT_VIA_RESPONSES=false` to keep them on Runtime Chat Completions.
