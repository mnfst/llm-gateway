export interface CallerAttribution {
  sdk?: string;
  sdkVersion?: string;
  runtime?: string;
  runtimeVersion?: string;
  os?: string;
  arch?: string;
  userAgent?: string;
  appName?: string;
  appUrl?: string;
  categories?: string[];
}

type HeaderMap = Record<string, string | string[] | undefined>;

const MAX_UA = 256;
const MAX_APP_NAME = 128;
const MAX_APP_URL = 512;
const MAX_RUNTIME = 32;
const MAX_OS = 32;
const MAX_ARCH = 16;
const MAX_SDK_VERSION = 32;
const MAX_CATEGORIES = 10;
const MAX_CATEGORY_LEN = 32;

export function classifyCaller(headers: HeaderMap): CallerAttribution | null {
  const ua = sanitize(headerValue(headers, 'user-agent'), MAX_UA);
  const referer = headerValue(headers, 'http-referer') ?? headerValue(headers, 'referer');
  const appName = sanitize(
    headerValue(headers, 'x-openrouter-title') ?? headerValue(headers, 'x-title'),
    MAX_APP_NAME,
  );
  const categoriesRaw = headerValue(headers, 'x-openrouter-categories');
  const stainlessLang = headerValue(headers, 'x-stainless-lang');
  const stainlessVersion = headerValue(headers, 'x-stainless-package-version');
  const stainlessRuntime = headerValue(headers, 'x-stainless-runtime');
  const stainlessRuntimeVer = headerValue(headers, 'x-stainless-runtime-version');
  const stainlessOs = headerValue(headers, 'x-stainless-os');
  const stainlessArch = headerValue(headers, 'x-stainless-arch');

  const { sdk, sdkVersion } = detectSdk(ua, stainlessLang, stainlessVersion);
  const appUrl = normalizeOrigin(referer);
  const categories = parseCategories(categoriesRaw);
  const runtime = sanitize(stainlessRuntime, MAX_RUNTIME);
  const runtimeVersion = sanitize(stainlessRuntimeVer, MAX_RUNTIME);
  const os = sanitize(stainlessOs, MAX_OS);
  const arch = sanitize(stainlessArch, MAX_ARCH);

  const attribution: CallerAttribution = {};
  if (sdk) attribution.sdk = sdk;
  if (sdkVersion) attribution.sdkVersion = sdkVersion;
  if (runtime) attribution.runtime = runtime;
  if (runtimeVersion) attribution.runtimeVersion = runtimeVersion;
  if (os) attribution.os = os;
  if (arch) attribution.arch = arch;
  if (ua) attribution.userAgent = ua;
  if (appName) attribution.appName = appName;
  if (appUrl) attribution.appUrl = appUrl;
  if (categories) attribution.categories = categories;

  return Object.keys(attribution).length > 0 ? attribution : null;
}

function headerValue(headers: HeaderMap, key: string): string | undefined {
  const v = headers[key];
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function sanitize(value: string | undefined, maxLen: number): string | undefined {
  if (value == null) return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

interface SdkInfo {
  sdk?: string;
  sdkVersion?: string;
}

function detectSdk(
  ua: string | undefined,
  stainlessLang: string | undefined,
  stainlessVersion: string | undefined,
): SdkInfo {
  if (ua) {
    const openai = ua.match(/^OpenAI\/(\w+)\s+([\d.]+)/i);
    if (openai) {
      return { sdk: `openai-${openai[1].toLowerCase()}`, sdkVersion: openai[2] };
    }

    const anthropic = ua.match(/^anthropic-(?:sdk|ai)[/-]([\w-]+)[/\s]([\d.]+)/i);
    if (anthropic) {
      return { sdk: `anthropic-${anthropic[1].toLowerCase()}`, sdkVersion: anthropic[2] };
    }

    const curl = ua.match(/^curl\/([\d.]+)/i);
    if (curl) return { sdk: 'curl', sdkVersion: curl[1] };

    const python = ua.match(/^python-requests\/([\d.]+)/i);
    if (python) return { sdk: 'python-requests', sdkVersion: python[1] };

    const nodeFetch = ua.match(/^node-fetch\/([\d.]+)/i);
    if (nodeFetch) return { sdk: 'node-fetch', sdkVersion: nodeFetch[1] };

    const axios = ua.match(/^axios\/([\d.]+)/i);
    if (axios) return { sdk: 'axios', sdkVersion: axios[1] };

    const n8nNode = ua.match(/^n8n-nodes-manifest(?:\/([\d.]+))?/i);
    if (n8nNode) return { sdk: 'n8n-nodes-manifest', sdkVersion: n8nNode[1] };
  }

  if (stainlessLang) {
    const lang = sanitize(stainlessLang, 16);
    if (lang) {
      return {
        sdk: `stainless-${lang.toLowerCase()}`,
        sdkVersion: sanitize(stainlessVersion, MAX_SDK_VERSION),
      };
    }
  }

  return ua ? { sdk: 'unknown' } : {};
}

function normalizeOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return sanitize(`${u.protocol}//${u.host}`, MAX_APP_URL);
  } catch {
    return sanitize(raw, MAX_APP_URL);
  }
}

function parseCategories(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts: string[] = [];
  for (const part of raw.split(',')) {
    const cleaned = sanitize(part, MAX_CATEGORY_LEN);
    if (cleaned) parts.push(cleaned);
    if (parts.length >= MAX_CATEGORIES) break;
  }
  return parts.length > 0 ? parts : undefined;
}
