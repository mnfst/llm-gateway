---
'manifest': patch
---

Bedrock model discovery now lists the Claude Fable 5 and 5.1 inference profiles and serves them through Bedrock Runtime Messages. AWS only allows these models when the account's Bedrock data retention mode for the Region is `aws_review` (or the legacy `provider_data_share`): prompts and completions are then retained within the AWS boundary for up to 30 days and may be reviewed by AWS, and are not shared with the model provider. Without it, Bedrock rejects the request with a 400 ValidationException.
