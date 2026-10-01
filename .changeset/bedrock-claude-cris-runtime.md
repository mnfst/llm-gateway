---
'manifest': patch
---

Route Claude cross-Region inference profiles on Amazon Bedrock (such as `us.anthropic.claude-sonnet-5-5`) to the Bedrock Runtime Anthropic Messages API instead of Mantle, which does not serve them.
