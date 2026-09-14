/**
 * Aggregated keyword sets used by the scoring engine. Keywords are split by
 * category under `./keywords/` — complexity dimensions live together in
 * `complexity.ts`, and each specificity category has its own file so new
 * categories can be added by dropping in a single file and updating the
 * mapping below (plus the shared `SPECIFICITY_CATEGORIES` list).
 */
import { COMPLEXITY_KEYWORDS } from './keywords/complexity';
import { WEB_BROWSING_KEYWORDS } from './keywords/web-browsing';
import { DATA_ANALYSIS_KEYWORDS } from './keywords/data-analysis';
import { IMAGE_GENERATION_KEYWORDS } from './keywords/image-generation';
import { VIDEO_GENERATION_KEYWORDS } from './keywords/video-generation';
import { SOCIAL_MEDIA_KEYWORDS } from './keywords/social-media';
import { EMAIL_MANAGEMENT_KEYWORDS } from './keywords/email-management';
import { CALENDAR_MANAGEMENT_KEYWORDS } from './keywords/calendar-management';
import { TRADING_KEYWORDS } from './keywords/trading';
import { PRIVATE_DOCS_KEYWORDS } from './keywords/private-docs';

export const DEFAULT_KEYWORDS: Record<string, string[]> = {
  ...COMPLEXITY_KEYWORDS,
  webBrowsing: WEB_BROWSING_KEYWORDS,
  dataAnalysis: DATA_ANALYSIS_KEYWORDS,
  imageGeneration: IMAGE_GENERATION_KEYWORDS,
  videoGeneration: VIDEO_GENERATION_KEYWORDS,
  socialMedia: SOCIAL_MEDIA_KEYWORDS,
  emailManagement: EMAIL_MANAGEMENT_KEYWORDS,
  calendarManagement: CALENDAR_MANAGEMENT_KEYWORDS,
  trading: TRADING_KEYWORDS,
  privateDocs: PRIVATE_DOCS_KEYWORDS,
};
