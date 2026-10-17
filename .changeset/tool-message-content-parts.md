---
'manifest': patch
---

Read tool messages whose `content` is an array of text parts on Gemini and Anthropic routes. Gemini received them as plain user text with no `functionResponse`, so the model's function call went unanswered, and Anthropic received the JSON of the parts array as the tool result instead of its text.
