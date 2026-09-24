/**
 * Multilingual keyword locale registry.
 *
 * Each locale exports keyword sets that mirror the structure of the base
 * English files. The scorer merges the appropriate locale set into the base
 * English set before running the trie scan — English behavior is unchanged
 * when no locale match is found.
 *
 * Language detection is performed by `franc-min` (< 1ms, fully local,
 * zero external API calls). Install with:
 *   npm install franc-min
 *
 * To force a specific locale without auto-detection, set:
 *   MANIFEST_LOCALE=pt-BR
 */

import { COMPLEXITY_KEYWORDS_PT_BR } from './pt-BR/complexity';
import { CALENDAR_MANAGEMENT_KEYWORDS_PT_BR } from './pt-BR/calendar-management';
import { DATA_ANALYSIS_KEYWORDS_PT_BR } from './pt-BR/data-analysis';
import { EMAIL_MANAGEMENT_KEYWORDS_PT_BR } from './pt-BR/email-management';
import { IMAGE_GENERATION_KEYWORDS_PT_BR } from './pt-BR/image-generation';
import { SOCIAL_MEDIA_KEYWORDS_PT_BR } from './pt-BR/social-media';
import { TRADING_KEYWORDS_PT_BR } from './pt-BR/trading';
import { VIDEO_GENERATION_KEYWORDS_PT_BR } from './pt-BR/video-generation';
import { WEB_BROWSING_KEYWORDS_PT_BR } from './pt-BR/web-browsing';

// ─── Fix P2a: strict type matching all 14 canonical complexity dimensions ────
// This ensures TypeScript catches incomplete locale files at compile time.
export type ComplexityDimensions = {
  formalLogic: string[];
  analyticalReasoning: string[];
  codeGeneration: string[];
  codeReview: string[];
  technicalTerms: string[];
  simpleIndicators: string[];
  multiStep: string[];
  creative: string[];
  questionComplexity: string[];
  imperativeVerbs: string[];
  outputFormat: string[];
  domainSpecificity: string[];
  agenticTasks: string[];
  relay: string[];
};

export interface LocaleKeywords {
  complexity: ComplexityDimensions;
  calendarManagement: string[];
  dataAnalysis: string[];
  emailManagement: string[];
  imageGeneration: string[];
  socialMedia: string[];
  trading: string[];
  videoGeneration: string[];
  webBrowsing: string[];
}

// ─── Fix P1: franc-min returns ISO-639-3 codes; map them to BCP-47 ──────────
// See: https://github.com/wooorm/franc#output
// 'por' (Portuguese), 'spa' (Spanish), 'fra' (French), 'deu' (German), etc.
const ISO639_3_TO_BCP47: Record<string, string> = {
  por: 'pt',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  jpn: 'ja',
  zho: 'zh',
  kor: 'ko',
  ita: 'it',
  nld: 'nl',
  pol: 'pl',
  rus: 'ru',
  tur: 'tr',
  ara: 'ar',
  hin: 'hi',
  eng: 'en',
};

/**
 * Map from BCP-47 language tag to locale keyword sets.
 * Add new locales here as they are implemented.
 */
export const LOCALE_KEYWORDS: Record<string, LocaleKeywords> = {
  'pt': {
    complexity: COMPLEXITY_KEYWORDS_PT_BR,
    calendarManagement: CALENDAR_MANAGEMENT_KEYWORDS_PT_BR,
    dataAnalysis: DATA_ANALYSIS_KEYWORDS_PT_BR,
    emailManagement: EMAIL_MANAGEMENT_KEYWORDS_PT_BR,
    imageGeneration: IMAGE_GENERATION_KEYWORDS_PT_BR,
    socialMedia: SOCIAL_MEDIA_KEYWORDS_PT_BR,
    trading: TRADING_KEYWORDS_PT_BR,
    videoGeneration: VIDEO_GENERATION_KEYWORDS_PT_BR,
    webBrowsing: WEB_BROWSING_KEYWORDS_PT_BR,
  },
  'pt-BR': {
    complexity: COMPLEXITY_KEYWORDS_PT_BR,
    calendarManagement: CALENDAR_MANAGEMENT_KEYWORDS_PT_BR,
    dataAnalysis: DATA_ANALYSIS_KEYWORDS_PT_BR,
    emailManagement: EMAIL_MANAGEMENT_KEYWORDS_PT_BR,
    imageGeneration: IMAGE_GENERATION_KEYWORDS_PT_BR,
    socialMedia: SOCIAL_MEDIA_KEYWORDS_PT_BR,
    trading: TRADING_KEYWORDS_PT_BR,
    videoGeneration: VIDEO_GENERATION_KEYWORDS_PT_BR,
    webBrowsing: WEB_BROWSING_KEYWORDS_PT_BR,
  },
  // Future locales:
  // 'es': { ... }
  // 'fr': { ... }
  // 'de': { ... }
};

/**
 * Detects the language of a text string.
 *
 * Returns a BCP-47 language code (e.g. 'pt', 'en', 'es') or null if
 * detection is undetermined or confidence is too low.
 *
 * Fix P1: franc-min returns ISO-639-3 codes (e.g. 'por'), which are
 * normalised here to BCP-47 (e.g. 'pt') before locale lookup.
 *
 * Falls back to MANIFEST_LOCALE env var if franc-min is not installed.
 */
export function detectLanguage(text: string): string | null {
  // 1. Env override always wins
  const envLocale = process.env.MANIFEST_LOCALE;
  if (envLocale) return envLocale;

  // 2. Try franc-min
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { franc } = require('franc-min') as { franc: (text: string) => string };
    const raw = franc(text); // e.g. 'por', 'eng', 'und'
    if (!raw || raw === 'und') return null;
    // Normalise ISO-639-3 → BCP-47
    return ISO639_3_TO_BCP47[raw] ?? raw;
  } catch {
    // franc-min not installed — degrade to English-only
  }

  return null;
}

/**
 * Returns the locale keyword set for a given BCP-47 language code,
 * or null if the language is unsupported (falls through to English scoring).
 *
 * Handles both exact matches ('pt-BR') and base-language fallbacks ('pt').
 */
export function getLocaleKeywords(lang: string | null): LocaleKeywords | null {
  if (!lang) return null;
  return LOCALE_KEYWORDS[lang] ?? LOCALE_KEYWORDS[lang.split('-')[0]] ?? null;
}

/**
 * Merges locale-specific complexity keywords into the base English set.
 * Returns a new merged object — does not mutate the originals.
 */
export function mergeComplexityKeywords(
  base: Record<string, string[]>,
  locale: LocaleKeywords | null,
): Record<string, string[]> {
  if (!locale) return base;

  const merged: Record<string, string[]> = { ...base };
  for (const [dimension, keywords] of Object.entries(locale.complexity)) {
    merged[dimension] = [...(merged[dimension] ?? []), ...keywords];
  }
  return merged;
}
