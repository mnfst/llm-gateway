---
'manifest': patch
---

Harden Bedrock Runtime routing after review: match the capability catalog by exact model ID, forward uncatalogued CRIS profiles optimistically (reserve the local M304 for catalogued models whose verified APIs exclude the request), drop legacy `max_tokens` when `max_completion_tokens` is required, propagate Manifest's stable prompt-cache key to the Runtime Chat/Responses endpoints, fall back to the priced Bedrock base entry when an exact CRIS profile lacks pricing, and warn when inference-profile pagination is truncated.
