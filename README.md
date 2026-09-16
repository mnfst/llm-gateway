<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-white.svg" />
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo-dark.svg" />
    <img src=".github/assets/logo-dark.svg" alt="Manifest LLM Gateway" height="53" title="Manifest LLM Gateway"/>
  </picture>
</p>
<p align="center">
AI Agents that don't break
</p>

![manifest-gh](https://github.com/user-attachments/assets/7dd74fc2-f7d6-4558-a95a-014ed754a125)

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/mnfst/llm-gateway" target="_blank" rel="nofollow"><img src="https://img.shields.io/badge/Deploy%20on-Render-46E3B7?style=for-the-badge&amp;logo=render&amp;logoColor=white" alt="Deploy on Render" /></a>
  <a href="https://railway.com/deploy/wild-wild" target="_blank" rel="nofollow"><img src="https://img.shields.io/badge/Deploy%20on-Railway-0B0D0E?style=for-the-badge&amp;logo=railway&amp;logoColor=white" alt="Deploy on Railway" /></a>
  <a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?stackName=manifest&amp;templateURL=https%3A%2F%2Fmnfst-manifest-deploy-templates.s3.us-east-1.amazonaws.com%2Fmanifest.yaml" target="_blank" rel="nofollow"><img src="https://img.shields.io/badge/Deploy%20on-AWS-232F3E?style=for-the-badge&amp;logo=amazonwebservices&amp;logoColor=white" alt="Deploy on AWS" /></a>
  <a href="https://ssh.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fmnfst%2Fllm-gateway&amp;cloudshell_workspace=deploy%2Fgcp&amp;cloudshell_tutorial=TUTORIAL.md&amp;cloudshell_image=gcr.io/ds-artifacts-cloudshell/deploystack_custom_image&amp;shellonly=true" target="_blank" rel="nofollow"><img src="https://img.shields.io/badge/Deploy%20on-GCP-4285F4?style=for-the-badge&amp;logo=googlecloud&amp;logoColor=white" alt="Deploy on GCP" /></a>
</p>

<p align="center">
  <a href="https://github.com/mnfst/llm-gateway/stargazers"><img src="https://img.shields.io/github/stars/mnfst/llm-gateway?style=flat" alt="GitHub stars" /></a>
  &nbsp;
  <a href="https://hub.docker.com/r/manifestdotbuild/manifest"><img src="https://img.shields.io/docker/pulls/manifestdotbuild/manifest?color=2496ED&label=docker%20pulls" alt="Docker pulls" /></a>
  &nbsp;
  <a href="https://hub.docker.com/r/manifestdotbuild/manifest/tags"><img src="https://img.shields.io/docker/image-size/manifestdotbuild/manifest/latest?color=2496ED&label=image%20size" alt="Docker image size" /></a>
  &nbsp;
  <a href="https://github.com/mnfst/llm-gateway/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/mnfst/llm-gateway/ci.yml?branch=main&label=CI" alt="CI status" /></a>
  &nbsp;
  <a href="https://app.codecov.io/gh/mnfst/llm-gateway"><img src="https://img.shields.io/codecov/c/github/mnfst/llm-gateway?label=coverage" alt="Codecov" /></a>
  &nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mnfst/llm-gateway?color=blue" alt="license" /></a>
  &nbsp;
  <a href="https://discord.gg/FepAked3W7"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
<a href="https://trendshift.io/repositories/12890" target="_blank"><img src="https://trendshift.io/api/badge/repositories/12890" alt="mnfst%2Fllm-gateway | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

> ### 🦚 Meet Manifest, the self-healing layer for APIs
>
> Manifest fixes failed API requests in real time, before they break your app. This open-source LLM gateway is a Manifest product and stays maintained.
>
> **[Try Manifest](https://dashboard.manifest.build/signup)**

## What is Manifest LLM Gateway?

Manifest LLM Gateway is an open-source LLM gateway for AI agents and apps. Connect your API keys, subscriptions, and local models to one OpenAI-compatible endpoint, and each query goes to the right model. No single-provider lock-in.

- 🔀 Custom Routing: API keys, Subscriptions, Local models, Custom providers
- 💾 Full Body Logs for Success and Error Messages
- 📊 Track every single dollar, setup notifications and limits
- 🚑 Fallback on different models when queries fail, Self-heals your bad requests

## Quick start

### Cloud version

Go to [app.manifest.build](https://app.manifest.build) and follow the guide.

### Self-hosted

Manifest ships as a [Docker image](https://hub.docker.com/r/manifestdotbuild/manifest). One command:

```bash
bash <(curl -sSL https://raw.githubusercontent.com/mnfst/llm-gateway/main/docker/install.sh)
```

Open [http://localhost:2099](http://localhost:2099) and sign up — the first account you create becomes the admin. Full self-hosting guide: [docker/DOCKER_README.md](docker/DOCKER_README.md).

### Deploy with one click

| Platform                                                                   | Notes                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Railway](https://railway.com/deploy/wild-wild)                            | Best path. Template includes Manifest, PostgreSQL, and S3-compatible storage for request recordings. |
| [Render](https://render.com/deploy?repo=https://github.com/mnfst/llm-gateway) | Blueprint includes Manifest, PostgreSQL, and a persistent recording disk.                            |
| [DigitalOcean](deploy/digitalocean/TUTORIAL.md)                            | App Platform and PostgreSQL; provide a private Space for recordings.                                 |
| [AWS](deploy/aws/TUTORIAL.md)                                              | CloudFormation provisions ECS, RDS, and a private recording bucket.                                  |
| [GCP](deploy/gcp/TUTORIAL.md)                                              | DeployStack provisions Cloud Run, Cloud SQL, and Cloud Storage.                                      |

> Every deployment path now uses durable request-recording storage. Railway, AWS, GCP, and Fly.io provision it natively; Render, Coolify, Easypanel, Docker, and Apple Containers mount persistent storage. DigitalOcean, Heroku, and Koyeb collect external S3-compatible settings during setup. Volume-backed templates are single-instance; use S3-compatible storage before scaling horizontally.

Full deployment guides: [Railway](https://manifest.build/docs/deploy/railway), [Render](https://manifest.build/docs/deploy/render), [DigitalOcean](https://manifest.build/docs/deploy/digitalocean), [AWS](https://manifest.build/docs/deploy/aws), [GCP](https://manifest.build/docs/deploy/gcp), [Fly.io](https://manifest.build/docs/deploy/fly), [Coolify](https://manifest.build/docs/deploy/coolify), [Easypanel](https://manifest.build/docs/deploy/easypanel), [Heroku](https://manifest.build/docs/deploy/heroku), [Koyeb](https://manifest.build/docs/deploy/koyeb), and [Apple Containers](deploy/apple-containers/TUTORIAL.md).

> The old npm-based self-hosting path is no longer supported. Use the Docker image or one of the deployment guides above.

## Providers

Manifest connects to **300+ models through 35 built-in provider connections** plus any custom OpenAI/Anthropic-compatible endpoint. Bring your own API key, reuse one of **18 subscription flows**, or run models locally. Everything is routed through the same OpenAI-compatible endpoint — send `"model": "auto"` and Manifest picks the model.

Provider catalogs are discovered dynamically when credentials are connected. The examples below are representative, not exhaustive.

| Provider                                                                                 | API key / local | Subscription                 | Model catalog                                                   |
| ---------------------------------------------------------------------------------------- | :-------------: | :--------------------------- | --------------------------------------------------------------- |
| [**OpenAI**](https://platform.openai.com/)                                               |       ✅        | ✅ ChatGPT Plus / Pro / Team | GPT-5.6 (Sol / Terra / Luna), GPT-5.5, GPT-5.4, Codex, o-series |
| [**Anthropic**](https://www.anthropic.com/)                                              |       ✅        | ✅ Claude Max / Pro          | Claude Opus 5, Sonnet 5, Fable 5, Haiku 4.5                     |
| [**Google**](https://ai.google.dev/)                                                     |       ✅        | ✅ Sign in with Google       | Gemini 3.5 Flash, 3.1 Flash-Lite, Gemini 2.5                    |
| [**Google Vertex AI**](https://cloud.google.com/vertex-ai)                               |       ✅        | —                            | Gemini models via Vertex AI                                     |
| **Gemini Free**                                                                          | ✅ Managed key  | —                            | Free Gemini models through Manifest's managed gateway           |
| [**Meta**](https://www.meta.ai/)                                                         |       ✅        | —                            | Muse Spark 1.2 / 1.1 + Contributor route (Meta Model API)       |
| [**xAI**](https://x.ai/)                                                                 |       ✅        | ✅ Grok subscription         | Grok 4.5, Grok 4.3, Grok Build, Grok 4.20                       |
| [**AWS Bedrock**](https://aws.amazon.com/bedrock/)                                       |       ✅        | —                            | Claude, GPT, Kimi, MiniMax, Nemotron, Nova via Bedrock          |
| [**Alibaba Cloud / Qwen**](https://www.alibabacloud.com/en/solutions/generative-ai/qwen) |       ✅        | ✅ Qwen Token Plan           | Qwen 3.7 Max / Plus / Flash, DeepSeek, Kimi, GLM                |
| [**DeepSeek**](https://www.deepseek.com/)                                                |       ✅        | —                            | DeepSeek V4 Pro, V4 Flash, V3.2, R1                             |
| [**Mistral**](https://mistral.ai/)                                                       |       ✅        | ✅ Mistral Vibe              | Mistral Large, Medium 3.5, Devstral, Codestral                  |
| [**Moonshot** (Kimi)](https://kimi.ai/)                                                  |       ✅        | ✅ Kimi Coding Plan          | Kimi K3, K2.7 Code, Kimi for Coding                             |
| [**MiniMax**](https://www.minimax.io/)                                                   |       ✅        | ✅ MiniMax Coding Plan       | MiniMax M3, M2.7, M2.5                                          |
| [**Xiaomi MiMo**](https://platform.xiaomimimo.com/)                                      |       ✅        | ✅ MiMo Token Plan           | MiMo V2.5 Pro, V2.5, Flash                                      |
| [**Z.ai**](https://z.ai/)                                                                |       ✅        | ✅ GLM Coding Plan           | GLM 5.2, GLM 5.1, GLM 5 Turbo                                   |
| [**BytePlus**](https://www.byteplus.com/en/activity/codingplan)                          |        —        | ✅ ModelArk Coding Plan      | Ark Code, Seed Code, GLM, Kimi, DeepSeek, GPT-OSS               |
| [**GitHub Copilot**](https://github.com/features/copilot)                                |        —        | ✅ Copilot subscription      | Claude, GPT, Gemini, Grok via Copilot                           |
| [**Kiro**](https://kiro.dev/)                                                            |        —        | ✅ Kiro subscription         | `kiro/auto`, Claude, DeepSeek, MiniMax, GLM, Qwen               |
| [**Command Code**](https://commandcode.ai/studio)                                        |        —        | ✅ Command Code subscription | Claude, DeepSeek V4, Qwen 3.7, Gemini, Kimi                     |
| [**ClinePass**](https://app.cline.bot/)                                                  |        —        | ✅ ClinePass subscription    | `cline-pass/glm-5.2`, Kimi, DeepSeek, MiMo, MiniMax, Qwen       |
| [**NousResearch**](https://portal.nousresearch.com/)                                     |        —        | ✅ NousResearch subscription | NousResearch Portal model catalog                               |
| [**OpenCode Go**](https://opencode.ai/)                                                  |        —        | ✅ OpenCode Go               | DeepSeek V4, Qwen 3.7, GLM, Kimi, MiMo                          |
| [**Ollama / Ollama Cloud**](https://ollama.com/)                                         |    🖥️ Local     | ✅ Ollama Cloud              | Local tags: Llama, Qwen, Gemma. Cloud: DeepSeek V4, GLM, Kimi   |
| [**LM Studio**](https://lmstudio.ai/)                                                    |    🖥️ Local     | —                            | Local GGUF models, port `1234`                                  |
| [**llama.cpp**](https://github.com/ggml-org/llama.cpp)                                   |    🖥️ Local     | —                            | Local GGUF models, port `8080`                                  |
| [**OpenRouter**](https://openrouter.ai/)                                                 |       ✅        | —                            | 300+ models across labs                                         |
| [**OpenCode Zen**](https://opencode.ai/)                                                 |       ✅        | —                            | Curated Claude, GPT, DeepSeek, MiMo, Nemotron                   |
| [**Kilo**](https://kilo.ai/)                                                             |       ✅        | —                            | Kilo Gateway catalog                                            |
| [**Cerebras**](https://www.cerebras.ai/)                                                 |       ✅        | —                            | GPT-OSS, GLM, Gemma on Cerebras inference                       |
| [**Fireworks AI**](https://fireworks.ai/)                                                |       ✅        | —                            | DeepSeek V4, Kimi K2.7, Qwen 3.7, Nemotron                      |
| [**Groq**](https://groq.com/)                                                            |       ✅        | —                            | Llama 4, Qwen 3.6, GPT-OSS, Gemma                               |
| [**Hugging Face**](https://huggingface.co/docs/inference-providers/)                     |       ✅        | —                            | Open models through Hugging Face Inference Providers            |
| [**NVIDIA NIM**](https://build.nvidia.com/)                                              |       ✅        | —                            | Nemotron 3, GLM, Kimi, MiniMax, Qwen                            |
| [**Pioneer**](https://pioneer.ai/)                                                       |       ✅        | —                            | OpenAI-compatible and fine-tuned Pioneer models                 |
| **Custom**                                                                               |       ✅        | —                            | Any `/v1/chat/completions` or `/v1/messages` endpoint           |

## Quick links

- [Docs](https://manifest.build/docs)
- [n8n community node](integrations/n8n-nodes-manifest) — `n8n-nodes-manifest` on npm
- [Discord](https://discord.com/invite/FepAked3W7)
- [Discussions](https://github.com/mnfst/llm-gateway/discussions)
- [Contributing](CONTRIBUTING.md)
- [GitHub](https://github.com/mnfst/llm-gateway)

## License

[MIT](LICENSE)
