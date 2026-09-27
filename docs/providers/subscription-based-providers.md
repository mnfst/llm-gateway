# Subscription-based providers

Reuse a paid plan you already have: ChatGPT Plus, Claude Max, GitHub Copilot, ModelArk Coding Plan, Command Code, Qwen Token Plan, Xiaomi MiMo Token Plan, Kimi Coding Plan, GLM Coding Plan, Google sign-in, MiniMax Coding Plan, Kiro, Grok, Ollama Cloud, or OpenCode Go.

If you already pay for one of the plans below, Manifest can route through that subscription instead of an API key. Auth is browser OAuth, device code, or a subscription token depending on the provider.

## Supported subscriptions

| Provider                                                    | Plan                        | Auth flow            | Model catalog                                        |
| ----------------------------------------------------------- | --------------------------- | -------------------- | ---------------------------------------------------- |
| [OpenAI](https://openai.com)                                | ChatGPT Plus/Pro/Team       | OAuth (browser)      | Fixed ChatGPT and Codex model list                   |
| [Anthropic](https://www.anthropic.com)                      | Claude Max / Pro            | Setup token          | `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-4` |
| [GitHub Copilot](https://github.com/features/copilot)       | GitHub Copilot subscription | Device code          | Fixed Copilot model list                             |
| [BytePlus](https://www.byteplus.com/en/activity/codingplan) | ModelArk Coding Plan        | Subscription token   | Fixed ModelArk Coding Plan model list                |
| [Command Code](https://commandcode.ai/studio)               | Command Code subscription   | Subscription token   | Dynamic Provider API catalog                         |
| [Qwen](https://home.qwencloud.com/api-keys)                 | Qwen Token Plan             | Subscription token   | Dynamic Token Plan catalog                           |
| [Xiaomi MiMo](https://platform.xiaomimimo.com)              | MiMo Token Plan             | Subscription token   | Fixed MiMo Token Plan model list                     |
| [Moonshot](https://www.kimi.com/code/console)               | Kimi Coding Plan            | Subscription token   | Fixed Kimi Coding Plan model list                    |
| [Z.ai](https://z.ai)                                        | GLM Coding Plan             | Subscription token   | Fixed GLM Coding Plan model list                     |
| [Google](https://ai.google.dev)                             | Sign in with Google         | OAuth (browser)      | Fixed Gemini CodeAssist model list                   |
| [MiniMax](https://www.minimax.io)                           | MiniMax Coding Plan         | Device code or token | Fixed MiniMax Coding Plan model list                 |
| [Kiro](https://app.kiro.dev)                                | Kiro subscription           | Device code          | Fixed Kiro model list                                |
| [xAI](https://x.ai)                                         | Grok subscription           | OAuth (browser)      | Dynamic xAI model catalog                            |
| [Ollama Cloud](https://ollama.com)                          | Ollama Cloud subscription   | Subscription token   | Dynamic Ollama Cloud tag catalog                     |
| [OpenCode Go](https://opencode.ai)                          | OpenCode Go (beta)          | Subscription token   | Dynamic OpenCode Go catalog                          |

## Connect a subscription

1. Open the Routing page in the dashboard.
2. Click the provider tile.
3. Pick the Subscription tab.
4. Complete the provider's auth flow.

Providers that support both API keys and subscriptions show both tabs. Subscription-only providers show only the subscription flow. In routing pickers, subscription rows appear only after a usable subscription credential is saved (`has_api_key=true`).

## How auth works per provider

### OpenAI

Manifest uses browser OAuth for ChatGPT Plus, Pro, and Team accounts. Once approved, requests route through the ChatGPT Codex backend instead of the public OpenAI API. Tokens refresh automatically.

### Anthropic

Run `claude setup-token` and paste the `sk-ant-oat` token into Manifest. Requests carry Anthropic subscription auth headers. Subscription mode does not support prompt caching or batching.

### GitHub Copilot

Manifest uses GitHub's device-code flow. Manifest gives you a short user code, you open `https://github.com/login/device`, paste the code, and approve access. Requests then route to the Copilot chat or responses endpoint with a short-lived token that Manifest refreshes.

### BytePlus

Paste a ModelArk Coding Plan API key from the BytePlus console. Manifest routes OpenAI-compatible and Anthropic-compatible coding-plan requests through BytePlus ModelArk endpoints.

### Command Code

Paste a Command Code API key from Command Code Studio. Command Code is subscription-only in Manifest and requires Command Code Pro or higher. Manifest discovers models dynamically from Command Code's public Provider API catalog.

### Qwen

Paste a Qwen Token Plan API key. Token Plan keys use the `sk-sp-` prefix. Manifest discovers available models from Qwen's Token Plan endpoint and can route both chat-completions and responses-style requests where supported.

### Xiaomi MiMo

Paste a MiMo Token Plan API key. Token Plan keys use the `tp-` prefix. Manifest routes through MiMo's OpenAI-compatible Token Plan endpoint and lets self-hosted setups choose the China, Singapore, or Europe token-plan host.

### Moonshot

Paste a Kimi Code API key from the Kimi Code console. Requests route through Kimi Code's Anthropic-compatible endpoint for the fixed `k3`, `k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed` model catalog.

### Z.ai

Paste a GLM Coding Plan token from Z.ai. Manifest routes to the Z.ai coding-plan endpoint. Self-hosted setups can choose the global or China Mainland endpoint when both are available.

### Google

Manifest uses browser OAuth for Google's CodeAssist flow. The subscription route uses a fixed Gemini CodeAssist model list rather than the public Gemini API-key catalog.

### MiniMax

Manifest supports the MiniMax Coding Plan device-code flow. Users with a Coding Plan token can also paste the token directly when the UI offers the token alternative.

### Kiro

Manifest uses Kiro's device-code flow. The Kiro subscription exposes `kiro/auto` plus curated Claude, DeepSeek, MiniMax, GLM, and Qwen routes behind one subscription.

### xAI

Manifest uses browser OAuth for Grok subscriptions and fetches the model list dynamically from xAI's OpenAI-compatible models endpoint.

### Ollama Cloud

Paste an Ollama Cloud API key. Ollama Cloud accepts generic API-key formats; Manifest does not require a fixed prefix. Models are discovered dynamically from the cloud tag catalog.

### OpenCode Go

Sign in to OpenCode Go, copy your API key, and paste it into Manifest. Model discovery is dynamic. Depending on the model, Manifest can route through OpenAI-compatible or Anthropic-compatible wire formats.

## Why mix subscriptions and API keys

A common setup is a subscription as the primary route for predictable monthly cost, plus API-key providers as fallbacks for plan limits, provider outages, or models the subscription does not include. Pin subscription models to routing tiers and add API-key models to the fallback list. Manifest handles the switch.
