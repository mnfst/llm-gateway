---
'manifest': patch
---

Non-streaming Gemini function calls with no arguments now keep `arguments` set to `"{}"`. A missing or null `args` used to omit the field or send the string `"null"`, and replaying that `"null"` forwarded `args: null` to Gemini.
