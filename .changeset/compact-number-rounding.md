---
'manifest': patch
---

Show compact token counts with the right unit and no trailing `.0` on the dashboard. A count from 999,950 to 999,999 was shown as `1000.0k` instead of `1M`, and a count that rounds to a whole number was shown as `1.0k` or `2.0M` instead of `1k` or `2M`.
