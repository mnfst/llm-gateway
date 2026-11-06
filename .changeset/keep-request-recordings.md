---
'manifest': patch
---

Request recordings are no longer deleted after a retention period on Manifest Cloud, for any plan. Self-hosted installs now keep them forever by default; set `REQUEST_RECORDING_RETENTION_DAYS` to delete older ones.
