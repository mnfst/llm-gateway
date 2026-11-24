import { SHARED_PROVIDER_BY_ID } from 'manifest-shared';

const MANAGED_FREE_PROVIDER_API_KEY_URL = 'https://calendly.com/sebastien-manifest/30min';

export const ROUTING_PROVIDER_API_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  bedrock: 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-generate.html',
  vertex: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview',
  cerebras: 'https://cloud.cerebras.ai',
  'cline-pass': 'https://app.cline.bot/settings/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  fireworks: 'https://app.fireworks.ai/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  kiro: 'https://app.kiro.dev',
  groq: 'https://console.groq.com/keys',
  huggingface: 'https://huggingface.co/settings/tokens',
  kilo: 'https://app.kilo.ai',
  meta: 'https://dev.meta.ai/',
  minimax: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  mistral: 'https://console.mistral.ai/api-keys/',
  moonshot: 'https://platform.moonshot.ai/',
  nvidia: 'https://build.nvidia.com/settings/api-keys',
  ollama: 'https://ollama.com/download',
  'ollama-cloud': 'https://ollama.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  pioneer: 'https://pioneer.ai',
  'opencode-zen': 'https://opencode.ai/auth',
  openrouter: 'https://openrouter.ai/keys',
  qwen: 'https://www.alibabacloud.com/help/en/model-studio/developer-reference/get-api-key',
  xiaomi: 'https://platform.xiaomimimo.com/console/api-keys',
  xai: 'https://docs.x.ai/docs/api-reference',
  zai: 'https://z.ai/manage-apikey/apikey-list',
};

export const getRoutingProviderApiKeyUrl = (providerId: string): string | undefined => {
  const configuredUrl = ROUTING_PROVIDER_API_KEY_URLS[providerId];
  if (configuredUrl) return configuredUrl;
  return SHARED_PROVIDER_BY_ID.get(providerId)?.managedFree
    ? MANAGED_FREE_PROVIDER_API_KEY_URL
    : undefined;
};

/**
 * Where to obtain a subscription token for each subscription-tab provider.
 * Kept separate from the API-key map because the subscription credential
 * often lives behind a different URL than the regular API console (e.g.
 * Anthropic setup-tokens come from the Claude Code CLI, not the API console).
 */
export const SUBSCRIPTION_PROVIDER_KEY_URLS: Record<string, string> = {
  byteplus: 'https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey',
  'cline-pass': 'https://app.cline.bot/settings/api-keys',
  commandcode: 'https://commandcode.ai/studio',
  nous: 'https://portal.nousresearch.com',
  qwen: 'https://home.qwencloud.com/api-keys',
  moonshot: 'https://www.kimi.com/code/console',
  'ollama-cloud': 'https://ollama.com/settings/keys',
  kiro: 'https://app.kiro.dev',
  mistral: 'https://chat.mistral.ai/code/extensions',
  xiaomi: 'https://platform.xiaomimimo.com/token-plan',
  zai: 'https://z.ai/manage-apikey/apikey-list',
};

export const getSubscriptionProviderKeyUrl = (providerId: string): string | undefined =>
  SUBSCRIPTION_PROVIDER_KEY_URLS[providerId];

export const EMAIL_PROVIDER_API_KEY_URLS: Record<string, string> = {
  resend: 'https://resend.com/api-keys',
  mailgun: 'https://app.mailgun.com/app/account/security/api_keys',
  sendgrid: 'https://app.sendgrid.com/settings/api_keys',
};

export const getEmailProviderApiKeyUrl = (providerId: string): string | undefined =>
  EMAIL_PROVIDER_API_KEY_URLS[providerId];
