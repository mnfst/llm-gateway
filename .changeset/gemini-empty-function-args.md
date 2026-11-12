---
'manifest': patch
---

Non-streaming Gemini function calls with no arguments now keep `arguments` set to `"{}"`. A missing or null `args` used to omit the field or send the string `"null"`; replayed non-object JSON such as `"null"` or `"[]"` is now sent as `{}` instead of an invalid Gemini `args` value.
