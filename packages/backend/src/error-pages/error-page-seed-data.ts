import type { ErrorPageTrendPoint } from '../entities/public-error-page.entity';

/**
 * Curated demo error pages published on boot (dev/test only) so the public
 * `/errors/` catalog on the marketing site has a full, chart-rich set to render
 * without a live Peacock CMS. Each entry is published through the same
 * `ErrorPagesService.upsert` valve as a real CMS push, so the k-anonymity floor
 * and secret/email scrub still apply. Content is illustrative, not real tenant
 * data — `tenants`/`volume_*` are plausible aggregates and every `sample_message`
 * is a public, provider-documented error shape.
 */
export interface ErrorPageSeed {
  slug: string;
  cluster_key: string;
  provider: string;
  provider_label: string;
  http_status: number;
  category: string;
  category_label: string;
  title: string;
  meta_description: string;
  h1: string;
  body_what: string;
  body_fix: string;
  sample_message: string;
  faq: { q: string; a: string }[];
  tenants: number;
  volume_7d: number;
  volume_30d: number;
  recovery_rate: number;
  variants?: string[];
}

const DAY_MS = 86400000;
const TREND_DAYS = 14;

/**
 * Build a 14-day occurrence sparkline that sums to roughly the 30-day volume,
 * with a gentle upward ramp and a deterministic wave (so the demo chart looks
 * alive without random noise, and tests stay stable). Never emits a zero day,
 * so the line always renders.
 */
export function seedTrend(volume30d: number, salt: number, endMs: number): ErrorPageTrendPoint[] {
  const perDay = Math.max(1, Math.round(volume30d / 30));
  const start = endMs - (TREND_DAYS - 1) * DAY_MS;
  const points: ErrorPageTrendPoint[] = [];
  for (let d = 0; d < TREND_DAYS; d++) {
    const wave = 0.7 + 0.6 * Math.abs(Math.sin((d + salt) * 0.6));
    const ramp = 0.6 + (0.8 * d) / (TREND_DAYS - 1);
    const count = Math.max(1, Math.round(perDay * wave * ramp));
    points.push({ date: new Date(start + d * DAY_MS).toISOString().slice(0, 10), count });
  }
  return points;
}

export const ERROR_PAGE_SEEDS: ErrorPageSeed[] = [
  {
    slug: 'gemini-429-quota-exceeded',
    cluster_key: 'gemini|rate_limited|429|RESOURCE_EXHAUSTED',
    provider: 'gemini',
    provider_label: 'Google Gemini',
    http_status: 429,
    category: 'rate_limit',
    category_label: 'Rate limit',
    title: 'Fix Gemini 429 "You exceeded your current quota"',
    meta_description:
      'Why Google Gemini returns 429 RESOURCE_EXHAUSTED across AI agents and how to stop it breaking runs.',
    h1: 'Gemini 429 — You exceeded your current quota',
    body_what:
      'Gemini returns HTTP 429 with RESOURCE_EXHAUSTED when a project crosses its per-minute or per-day quota. Bursty agent loops hit it first.',
    body_fix:
      '- Back off and retry with exponential jitter\n- Request a quota increase in Google AI Studio\n- Spread load across keys or fall back to another model',
    sample_message:
      '{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details.", "status": "RESOURCE_EXHAUSTED" } }',
    faq: [
      {
        q: 'Is a Gemini 429 the same as being rate limited?',
        a: 'Yes. RESOURCE_EXHAUSTED means you hit a per-minute or per-day quota; it clears once the window resets.',
      },
    ],
    tenants: 120,
    volume_7d: 297,
    volume_30d: 720,
    recovery_rate: 0.74,
    variants: [
      'Resource has been exhausted (e.g. check quota).',
      'Quota exceeded for quota metric "Generate Content API requests per minute".',
    ],
  },
  {
    slug: 'gemini-400-missing-thought-signature',
    cluster_key: 'gemini|error|400|INVALID_ARGUMENT',
    provider: 'gemini',
    provider_label: 'Google Gemini',
    http_status: 400,
    category: 'bad_request',
    category_label: 'Bad request',
    title: 'Fix Gemini 400 "missing thought_signature" in function calls',
    meta_description:
      'Gemini 2.5 rejects tool calls that drop the thought_signature. Here is why and how to keep function calling working.',
    h1: 'Gemini 400 — Function call missing a thought_signature',
    body_what:
      'Gemini 2.5 returns 400 INVALID_ARGUMENT when a functionCall part is replayed without the thought_signature it originally issued.',
    body_fix:
      '- Preserve thought_signature on every functionCall part you send back\n- Keep function turns immediately after the matching user or tool turn\n- Do not hand-edit or truncate prior tool messages',
    sample_message:
      '{ "error": { "code": 400, "message": "Function call is missing a thought_signature in functionCall parts.", "status": "INVALID_ARGUMENT" } }',
    faq: [
      {
        q: 'Why did this start after upgrading to Gemini 2.5?',
        a: 'Thought signatures are new to 2.5 thinking models; older clients that strip unknown fields drop them and trigger the 400.',
      },
    ],
    tenants: 42,
    volume_7d: 61,
    volume_30d: 168,
    recovery_rate: 0.66,
  },
  {
    slug: 'gemini-503-overloaded',
    cluster_key: 'gemini|error|503|UNAVAILABLE',
    provider: 'gemini',
    provider_label: 'Google Gemini',
    http_status: 503,
    category: 'server',
    category_label: 'Server error',
    title: 'Fix Gemini 503 "model is overloaded / UNAVAILABLE"',
    meta_description:
      'Gemini 503 UNAVAILABLE spikes when demand surges. How to ride it out without failing agent runs.',
    h1: 'Gemini 503 — The model is currently overloaded',
    body_what:
      'A 503 UNAVAILABLE is server-side: Gemini is briefly saturated. It is transient but clusters during peak hours.',
    body_fix:
      '- Retry after a short delay with backoff\n- Fail over to a second model on repeated 503s\n- Avoid hammering the same region during a spike',
    sample_message:
      '{ "error": { "code": 503, "message": "The model is currently experiencing high demand. Spikes in demand are usually temporary.", "status": "UNAVAILABLE" } }',
    faq: [
      {
        q: 'Is a 503 my fault?',
        a: 'No. It is a temporary capacity issue on the provider; a retry or fallback usually succeeds within seconds.',
      },
    ],
    tenants: 40,
    volume_7d: 96,
    volume_30d: 150,
    recovery_rate: 0.79,
  },
  {
    slug: 'openai-401-invalid-authentication',
    cluster_key: 'openai|error|401|invalid_authentication',
    provider: 'openai',
    provider_label: 'OpenAI',
    http_status: 401,
    category: 'auth',
    category_label: 'Authentication',
    title: 'Fix OpenAI 401 "invalid authentication" / bad API key',
    meta_description:
      'OpenAI 401 invalid_authentication means the key is missing, wrong, or revoked. How to find and fix it fast.',
    h1: 'OpenAI 401 — Invalid authentication',
    body_what:
      'OpenAI returns 401 when the API key is missing, malformed, revoked, or scoped to the wrong org or project.',
    body_fix:
      '- Confirm the Authorization: Bearer header carries a current key\n- Rotate the key if it may be leaked or revoked\n- Check the org and project the key is scoped to',
    sample_message:
      '{ "error": { "message": "Your authentication token has been invalidated. Please try signing in again.", "type": "invalid_request_error", "code": "invalid_authentication" } }',
    faq: [
      {
        q: 'Why did a working key suddenly 401?',
        a: 'Keys 401 the moment they are rotated or revoked, or if the project they belong to is deleted.',
      },
    ],
    tenants: 55,
    volume_7d: 120,
    volume_30d: 385,
    recovery_rate: 0.42,
    variants: ['Incorrect API key provided.'],
  },
  {
    slug: 'openai-429-rate-limit',
    cluster_key: 'openai|rate_limited|429|rate_limit_exceeded',
    provider: 'openai',
    provider_label: 'OpenAI',
    http_status: 429,
    category: 'rate_limit',
    category_label: 'Rate limit',
    title: 'Fix OpenAI 429 "rate limit exceeded"',
    meta_description:
      'OpenAI 429s cap requests-per-minute and tokens-per-minute. How to smooth bursts so agents keep running.',
    h1: 'OpenAI 429 — Rate limit exceeded',
    body_what:
      'OpenAI throttles by requests-per-minute and tokens-per-minute per model. Parallel agent calls trip it in bursts.',
    body_fix:
      '- Honor the Retry-After header before retrying\n- Add client-side concurrency limits\n- Request a higher tier or split traffic across models',
    sample_message:
      '{ "error": { "message": "Rate limit reached for requests. Limit 3500 per min.", "type": "requests", "code": "rate_limit_exceeded" } }',
    faq: [
      {
        q: 'RPM or TPM — which limit am I hitting?',
        a: 'The error names it: "requests" is per-minute request cap, "tokens" is per-minute token cap.',
      },
    ],
    tenants: 68,
    volume_7d: 210,
    volume_30d: 540,
    recovery_rate: 0.7,
  },
  {
    slug: 'openai-400-context-length-exceeded',
    cluster_key: 'openai|error|400|context_length_exceeded',
    provider: 'openai',
    provider_label: 'OpenAI',
    http_status: 400,
    category: 'bad_request',
    category_label: 'Bad request',
    title: 'Fix OpenAI 400 "context length exceeded"',
    meta_description:
      "OpenAI 400 context_length_exceeded means the prompt plus completion is over the model's window. How to trim it.",
    h1: 'OpenAI 400 — Context length exceeded',
    body_what:
      "A 400 context_length_exceeded fires when input tokens plus max_tokens exceed the model's context window.",
    body_fix:
      '- Trim or summarize history before sending\n- Lower max_tokens to leave room for the prompt\n- Move to a longer-context model for big inputs',
    sample_message:
      '{ "error": { "message": "This model\'s maximum context length is 128000 tokens.", "type": "invalid_request_error", "code": "context_length_exceeded" } }',
    faq: [
      {
        q: 'Does max_tokens count toward the limit?',
        a: 'Yes. The window must fit prompt tokens plus the completion you reserve with max_tokens.',
      },
    ],
    tenants: 34,
    volume_7d: 70,
    volume_30d: 210,
    recovery_rate: 0.88,
  },
  {
    slug: 'anthropic-400-out-of-extra-usage',
    cluster_key: 'anthropic|error|400|invalid_request_error',
    provider: 'anthropic',
    provider_label: 'Anthropic',
    http_status: 400,
    category: 'bad_request',
    category_label: 'Bad request',
    title: 'Fix Anthropic "you are out of extra usage"',
    meta_description:
      'Claude returns a 400 invalid_request_error when a plan runs out of extra usage. What it means and how to keep going.',
    h1: 'Anthropic 400 — You are out of extra usage',
    body_what:
      'Claude rejects the request when the account has spent its included plus extra usage allowance for the period.',
    body_fix:
      '- Add or raise the extra usage limit at claude.ai\n- Switch that agent to an API-key provider with credit\n- Fall back to a cheaper model for low-stakes calls',
    sample_message:
      '{ "type": "error", "error": { "type": "invalid_request_error", "message": "You are out of extra usage. Add more at claude.ai to keep going." } }',
    faq: [
      {
        q: 'Is this a billing or a rate error?',
        a: 'Billing. It clears when you raise the usage cap or the billing period resets, not by retrying.',
      },
    ],
    tenants: 30,
    volume_7d: 66,
    volume_30d: 150,
    recovery_rate: 0.7,
  },
  {
    slug: 'anthropic-529-overloaded',
    cluster_key: 'anthropic|error|529|overloaded_error',
    provider: 'anthropic',
    provider_label: 'Anthropic',
    http_status: 529,
    category: 'server',
    category_label: 'Server error',
    title: 'Fix Anthropic 529 "overloaded_error"',
    meta_description:
      'Claude 529 overloaded_error means the API is briefly saturated. How to retry and fail over cleanly.',
    h1: 'Anthropic 529 — Overloaded',
    body_what:
      'A 529 overloaded_error is server-side back-pressure from Anthropic during demand spikes. It is transient.',
    body_fix:
      '- Retry with exponential backoff and jitter\n- Fail over to another provider on repeated 529s\n- Cap concurrency during known peak windows',
    sample_message:
      '{ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }',
    faq: [
      {
        q: 'Why 529 and not 503?',
        a: 'Anthropic uses 529 specifically for capacity overload; treat it like a retryable 503.',
      },
    ],
    tenants: 26,
    volume_7d: 72,
    volume_30d: 96,
    recovery_rate: 0.83,
  },
  {
    slug: 'openrouter-402-insufficient-credits',
    cluster_key: 'openrouter|error|402|insufficient_credits',
    provider: 'openrouter',
    provider_label: 'OpenRouter',
    http_status: 402,
    category: 'billing',
    category_label: 'Billing / quota',
    title: 'Fix OpenRouter 402 "insufficient credits"',
    meta_description:
      'OpenRouter 402 means the account or free tier is out of credits. How to top up or route around it.',
    h1: 'OpenRouter 402 — Insufficient credits',
    body_what:
      'OpenRouter returns 402 when paid credits run out, or when a free model exhausts its daily allowance.',
    body_fix:
      '- Top up credits on the OpenRouter dashboard\n- Route free-tier traffic to a key-backed provider\n- Watch the free-models-per-day cap in agent loops',
    sample_message:
      '{ "error": { "message": "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day.", "code": 402 } }',
    faq: [
      {
        q: 'Why a 402 on a free model?',
        a: 'Free models share a daily request cap; once spent, OpenRouter returns 402 until you add credits or the day resets.',
      },
    ],
    tenants: 70,
    volume_7d: 150,
    volume_30d: 420,
    recovery_rate: 0.88,
  },
  {
    slug: 'openrouter-404-model-not-found',
    cluster_key: 'openrouter|error|404|no_endpoints',
    provider: 'openrouter',
    provider_label: 'OpenRouter',
    http_status: 404,
    category: 'model_unavailable',
    category_label: 'Model unavailable',
    title: 'Fix OpenRouter 404 "no endpoints found for model"',
    meta_description:
      'OpenRouter 404 means the requested model id has no available provider right now. How to pick a live one.',
    h1: 'OpenRouter 404 — No endpoints found for model',
    body_what:
      'A 404 means the model slug is wrong, deprecated, or every provider behind it is temporarily unavailable.',
    body_fix:
      '- Verify the exact model id against the OpenRouter models list\n- Drop provider filters that exclude every endpoint\n- Fall back to an equivalent model that is live',
    sample_message:
      '{ "error": { "message": "No endpoints found for the requested model.", "code": 404 } }',
    faq: [
      {
        q: 'The model existed yesterday — why 404 now?',
        a: 'Models get deprecated or briefly lose all providers; pin to a current id or add a fallback.',
      },
    ],
    tenants: 80,
    volume_7d: 130,
    volume_30d: 400,
    recovery_rate: 0.81,
  },
  {
    slug: 'deepseek-400-reasoning-content-required',
    cluster_key: 'deepseek|error|400|reasoning_content',
    provider: 'deepseek',
    provider_label: 'DeepSeek',
    http_status: 400,
    category: 'bad_request',
    category_label: 'Bad request',
    title: 'Fix DeepSeek 400 "reasoning_content must be passed"',
    meta_description:
      'DeepSeek reasoner rejects turns that drop reasoning_content or stack same-role messages. How to shape the request.',
    h1: 'DeepSeek 400 — reasoning_content must be passed',
    body_what:
      'deepseek-reasoner requires the prior reasoning_content on follow-up turns and rejects successive same-role messages.',
    body_fix:
      '- Echo the assistant reasoning_content back on the next turn\n- Never send two user or two assistant messages in a row\n- Strip reasoning_content only for non-reasoner models',
    sample_message:
      '{ "error": { "message": "The reasoning_content in the thinking mode must be passed.", "code": 400 } }',
    faq: [
      {
        q: 'Do normal chat models need reasoning_content?',
        a: 'No. Only the reasoner enforces it; sending it to a plain chat model can itself error.',
      },
    ],
    tenants: 48,
    volume_7d: 96,
    volume_30d: 240,
    recovery_rate: 0.6,
  },
  {
    slug: 'groq-429-rate-limit',
    cluster_key: 'groq|rate_limited|429|rate_limit_exceeded',
    provider: 'groq',
    provider_label: 'Groq',
    http_status: 429,
    category: 'rate_limit',
    category_label: 'Rate limit',
    title: 'Fix Groq 429 "rate limit exceeded"',
    meta_description:
      'Groq 429s cap requests and tokens per minute per model. How to pace bursts so agents keep flowing.',
    h1: 'Groq 429 — Rate limit exceeded',
    body_what:
      'Groq enforces tight per-minute request and token limits per model; fast agent loops hit them in bursts.',
    body_fix:
      '- Wait for the window in the Retry-After header\n- Throttle concurrency on the client\n- Spread load across models or request a limit bump',
    sample_message:
      '{ "error": { "message": "Rate limit reached for model llama-3.3-70b in organization on tokens per minute (TPM).", "code": "rate_limit_exceeded", "type": "tokens" } }',
    faq: [
      {
        q: 'Why does Groq rate limit so aggressively?',
        a: 'Its very high throughput comes with tight per-minute caps; pacing and fallbacks keep runs alive.',
      },
    ],
    tenants: 38,
    volume_7d: 140,
    volume_30d: 300,
    recovery_rate: 0.76,
  },
];
