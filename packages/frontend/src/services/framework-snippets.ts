// Platform setup snippets moved to manifest-shared so the CLI consumes the
// same setup truth; re-exported here to keep existing imports working.
import {
  getOpenClawSnippet,
  getClaudeCodeSettingsSnippet,
  getNanobotConfigSnippet,
} from 'manifest-shared';
export { getOpenClawSnippet, getClaudeCodeSettingsSnippet, getNanobotConfigSnippet };

export type FrameworkId = 'python' | 'typescript' | 'openclaw' | 'curl';

export interface FrameworkTab {
  id: FrameworkId;
  label: string;
}

export const FRAMEWORK_TABS: FrameworkTab[] = [
  { id: 'python', label: 'Python' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'curl', label: 'cURL' },
];

export type ToolkitId = 'openai-sdk' | 'anthropic-sdk' | 'vercel-ai-sdk' | 'langchain' | 'curl';
export type OpenAILangId = 'python' | 'typescript';
export type OpenAIApiId = 'responses' | 'chat-completions';

export interface ToolkitTab {
  id: ToolkitId;
  label: string;
  icon?: string;
}

export const TOOLKIT_TABS: ToolkitTab[] = [
  { id: 'openai-sdk', label: 'OpenAI SDK', icon: '/icons/providers/openai.svg' },
  { id: 'anthropic-sdk', label: 'Anthropic SDK', icon: '/icons/providers/anthropic.svg' },
  { id: 'vercel-ai-sdk', label: 'Vercel AI SDK', icon: '/icons/vercel.svg' },
  { id: 'langchain', label: 'LangChain', icon: '/icons/langchain.svg' },
  { id: 'curl', label: 'cURL' },
];

export interface OpenAILangTab {
  id: OpenAILangId;
  label: string;
  icon: string;
}

export interface OpenAIApiTab {
  id: OpenAIApiId;
  label: string;
}

export const SDK_LANG_TOGGLE: OpenAILangTab[] = [
  { id: 'python', label: 'Python', icon: '/icons/python.svg' },
  { id: 'typescript', label: 'TypeScript', icon: '/icons/typescript.svg' },
];

export const OPENAI_API_TOGGLE: OpenAIApiTab[] = [
  { id: 'responses', label: 'Responses API' },
  { id: 'chat-completions', label: 'Chat Completions' },
];

/** @deprecated Use SDK_LANG_TOGGLE instead */
export const OPENAI_SDK_LANGS = SDK_LANG_TOGGLE;

export interface Snippet {
  title: string;
  code: string;
}

const STORAGE_KEY = 'manifest_setup_framework';
const TOOLKIT_STORAGE_KEY = 'manifest_setup_toolkit';
const OPENAI_LANG_STORAGE_KEY = 'manifest_setup_openai_lang';

export function getStoredFramework(): FrameworkId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && FRAMEWORK_TABS.some((t) => t.id === stored)) return stored as FrameworkId;
  } catch {
    /* localStorage unavailable */
  }
  return 'python';
}

export function storeFramework(id: FrameworkId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* localStorage unavailable */
  }
}

export type CustomHeaders = Record<string, string>;

/**
 * `{"x-key": "value", "x-other": "v"}` rendered for the target language.
 * Uses JSON.stringify for both keys and values so embedded quotes/backslashes
 * are escaped properly even though we already reject them at input validation
 * time — defense in depth against future regressions or bypasses.
 */
function renderHeadersDict(headers: CustomHeaders | undefined, lang: 'py' | 'ts'): string | null {
  if (!headers) return null;
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  const inner = entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ');
  return lang === 'py' ? `{${inner}}` : `{ ${inner} }`;
}

/**
 * Renders a single header-line clause (e.g. `\n    default_headers={...},`)
 * for splicing inside a snippet's constructor args. Returns '' when no headers
 * are configured, so call sites collapse to no-op naturally.
 */
function headerLine(
  headers: CustomHeaders | undefined,
  syntax: 'py-kwarg' | 'ts-prop',
  keyword: string,
): string {
  const lang = syntax === 'py-kwarg' ? 'py' : 'ts';
  const dict = renderHeadersDict(headers, lang);
  if (!dict) return '';
  const indent = syntax === 'py-kwarg' ? '\n    ' : '\n  ';
  const sep = syntax === 'py-kwarg' ? '=' : ': ';
  return `${indent}${keyword}${sep}${dict},`;
}

function getOpenAIChatPythonSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet {
  const openaiHeaders = headerLine(customHeaders, 'py-kwarg', 'default_headers');
  return {
    title: 'Chat Completions',
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",${openaiHeaders}
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)`,
  };
}

function getOpenAIChatTypeScriptSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet {
  const openaiHeaders = headerLine(customHeaders, 'ts-prop', 'defaultHeaders');
  return {
    title: 'Chat Completions',
    code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${apiKey}",${openaiHeaders}
});

const response = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});`,
  };
}

/**
 * The Anthropic SDK appends `/v1/messages` to the configured base URL, so
 * the URL we render must NOT end in `/v1` — otherwise the SDK hits
 * `/v1/v1/messages` and gets a 404. Other SDKs (OpenAI, Vercel) expect
 * `/v1` in the base URL, so we only strip it for Anthropic.
 */
function stripV1Suffix(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function getAnthropicPythonSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet {
  const headersLine = headerLine(customHeaders, 'py-kwarg', 'default_headers');
  const url = stripV1Suffix(baseUrl);
  return {
    title: 'Anthropic Python SDK',
    code: `from anthropic import Anthropic

client = Anthropic(
    base_url="${url}",
    auth_token="${apiKey}",${headersLine}
)

message = client.messages.create(
    model="auto",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)`,
  };
}

function getAnthropicTypeScriptSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet {
  const headersLine = headerLine(customHeaders, 'ts-prop', 'defaultHeaders');
  const url = stripV1Suffix(baseUrl);
  return {
    title: 'Anthropic TypeScript SDK',
    code: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${url}",
  authToken: "${apiKey}",${headersLine}
});

const message = await client.messages.create({
  model: "auto",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});`,
  };
}

export function getPythonSnippets(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet[] {
  const langchainHeaders = headerLine(customHeaders, 'py-kwarg', 'default_headers');
  const openaiHeaders = headerLine(customHeaders, 'py-kwarg', 'default_headers');
  return [
    {
      title: 'LangChain',
      code: `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
    model="auto",${langchainHeaders}
)`,
    },
    {
      title: 'OpenAI Python SDK',
      code: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",${openaiHeaders}
)

response = client.responses.create(
    model="auto",
    input="Hello",
    store=False,
)`,
    },
  ];
}

export function getVercelPythonSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet {
  const headersLine = headerLine(customHeaders, 'py-kwarg', 'default_headers');
  return {
    title: 'Vercel AI SDK (Python)',
    code: `# pip install ai-sdk
from ai_sdk import AIClient

client = AIClient(
    base_url="${baseUrl}",
    api_key="${apiKey}",${headersLine}
)

response = client.generate_text(
    model="auto",
    prompt="Hello",
)`,
  };
}

export function getTypeScriptSnippets(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet[] {
  const vercelHeaders = headerLine(customHeaders, 'ts-prop', 'headers');
  const openaiHeaders = headerLine(customHeaders, 'ts-prop', 'defaultHeaders');
  return [
    {
      title: 'Vercel AI SDK',
      code: `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const manifest = createOpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${apiKey}",${vercelHeaders}
});

const { text } = await generateText({
  model: manifest("auto"),
  prompt: "Hello",
});`,
    },
    {
      title: 'OpenAI TypeScript SDK',
      code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${apiKey}",${openaiHeaders}
});

const response = await client.responses.create({
  model: "auto",
  input: "Hello",
  store: false,
});`,
    },
  ];
}

export function getOpenClawDisableSnippet(model: string): string {
  return `openclaw config unset models.providers.manifest
openclaw config unset agents.defaults.models.manifest/auto
openclaw config set agents.defaults.model.primary ${model}
openclaw gateway restart`;
}

export function getCurlSnippet(
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet[] {
  // Wrap each header arg in single quotes so embedded double-quotes (already
  // rejected at input validation but defended against here too) can't break
  // out of the shell string.
  const extraHeaders = customHeaders
    ? Object.entries(customHeaders)
        .map(([k, v]) => `  -H '${k}: ${v}' \\\n`)
        .join('')
    : '';
  return [
    {
      title: 'cURL',
      code: `curl -X POST ${baseUrl}/responses \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
${extraHeaders}  -d '{
    "model": "auto",
    "input": "Hello",
    "store": false
  }'`,
    },
  ];
}

export function getSnippetsForFramework(
  id: FrameworkId,
  baseUrl: string,
  apiKey: string,
  customHeaders?: CustomHeaders,
): Snippet[] {
  switch (id) {
    case 'python':
      return getPythonSnippets(baseUrl, apiKey, customHeaders);
    case 'typescript':
      return getTypeScriptSnippets(baseUrl, apiKey, customHeaders);
    case 'openclaw':
      return [{ title: 'OpenClaw CLI', code: getOpenClawSnippet(baseUrl, apiKey) }];
    case 'curl':
      return getCurlSnippet(baseUrl, apiKey, customHeaders);
  }
}

export function getStoredToolkit(): ToolkitId {
  try {
    const stored = localStorage.getItem(TOOLKIT_STORAGE_KEY);
    if (stored && TOOLKIT_TABS.some((t) => t.id === stored)) return stored as ToolkitId;
  } catch {
    /* localStorage unavailable */
  }
  return 'openai-sdk';
}

export function storeToolkit(id: ToolkitId): void {
  try {
    localStorage.setItem(TOOLKIT_STORAGE_KEY, id);
  } catch {
    /* localStorage unavailable */
  }
}

export function getStoredOpenAILang(): OpenAILangId {
  try {
    const stored = localStorage.getItem(OPENAI_LANG_STORAGE_KEY);
    if (stored === 'python' || stored === 'typescript') return stored;
  } catch {
    /* localStorage unavailable */
  }
  return 'python';
}

export function storeOpenAILang(id: OpenAILangId): void {
  try {
    localStorage.setItem(OPENAI_LANG_STORAGE_KEY, id);
  } catch {
    /* localStorage unavailable */
  }
}

export function getSnippetForToolkit(
  id: ToolkitId,
  baseUrl: string,
  apiKey: string,
  openaiLang: OpenAILangId = 'python',
  customHeaders?: CustomHeaders,
  openaiApi: OpenAIApiId = 'responses',
): Snippet {
  switch (id) {
    case 'openai-sdk':
      if (openaiApi === 'chat-completions') {
        return openaiLang === 'python'
          ? getOpenAIChatPythonSnippet(baseUrl, apiKey, customHeaders)
          : getOpenAIChatTypeScriptSnippet(baseUrl, apiKey, customHeaders);
      }
      return openaiLang === 'python'
        ? getPythonSnippets(baseUrl, apiKey, customHeaders)[1]!
        : getTypeScriptSnippets(baseUrl, apiKey, customHeaders)[1]!;
    case 'anthropic-sdk':
      return openaiLang === 'python'
        ? getAnthropicPythonSnippet(baseUrl, apiKey, customHeaders)
        : getAnthropicTypeScriptSnippet(baseUrl, apiKey, customHeaders);
    case 'vercel-ai-sdk':
      return openaiLang === 'python'
        ? getVercelPythonSnippet(baseUrl, apiKey, customHeaders)
        : getTypeScriptSnippets(baseUrl, apiKey, customHeaders)[0]!;
    case 'langchain':
      return getPythonSnippets(baseUrl, apiKey, customHeaders)[0]!;
    case 'curl':
      return getCurlSnippet(baseUrl, apiKey, customHeaders)[0]!;
  }
}

export function getLangForToolkit(id: ToolkitId, openaiLang?: OpenAILangId): string {
  switch (id) {
    case 'openai-sdk':
      return openaiLang === 'typescript' ? 'typescript' : 'python';
    case 'anthropic-sdk':
      return openaiLang === 'typescript' ? 'typescript' : 'python';
    case 'vercel-ai-sdk':
      return openaiLang === 'typescript' ? 'typescript' : 'python';
    case 'langchain':
      return 'python';
    case 'curl':
      return 'bash';
  }
}

export function getOpenClawWizardSnippet(): string {
  return 'openclaw onboard';
}
