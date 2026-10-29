---
'manifest': patch
---

Keep parallel tool calls apart when a provider streams them without an index, in recorded conversations and in the /v1/messages and /v1/responses translations. A delta without an index starts the next call when it brings a new id.
