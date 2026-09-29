---
"manifest": minor
---

Serve Amazon Bedrock cross-Region inference profiles such as `global.moonshotai.kimi-k3` and `us.openai.gpt-6-sol` through Bedrock Runtime instead of Mantle, which returned 404 for them. Bedrock connections now discover the profiles their region offers for verified models (Kimi K3, GPT-6 Sol, Luna and Astra, GPT-5.6 Luna) and keep them when the Bedrock control plane is briefly unreachable.
