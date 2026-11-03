---
'manifest': patch
---

Bedrock discovery now lists the Claude Fable 5 and 5.1 inference profiles. AWS only serves them when the Region's data retention mode is `aws_review` (or legacy `provider_data_share`), which retains prompts and completions for up to 30 days and lets AWS review them; otherwise Bedrock answers 400.
