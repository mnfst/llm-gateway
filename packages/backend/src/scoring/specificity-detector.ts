import { TrieMatch } from './keyword-trie';
import { ScorerTool, extractToolName } from './types';
import { SpecificityCategory, SPECIFICITY_CATEGORIES } from 'manifest-shared';
import { ACTIVATION_THRESHOLDS, weightFor } from './specificity-weights';
import { computeSignalBoosts } from './specificity-signals';

export interface SpecificityResult {
  category: SpecificityCategory;
  confidence: number;
}

/**
 * Maps each specificity category to the scoring dimensions that signal it.
 * These dimensions are already scanned by the keyword trie — we just read
 * how many matches each produced.
 */
const DIMENSION_MAP: Record<SpecificityCategory, string[]> = {
  coding: ['codeGeneration', 'codeReview', 'technicalTerms', 'codeToProse'],
  web_browsing: ['webBrowsing'],
  data_analysis: ['domainSpecificity', 'dataAnalysis'],
  image_generation: ['imageGeneration'],
  video_generation: ['videoGeneration'],
  social_media: ['socialMedia'],
  email_management: ['emailManagement'],
  calendar_management: ['calendarManagement'],
  trading: ['trading'],
  private_docs: ['privateDocs'],
};

/**
 * Tool-name prefix patterns that boost a specificity category.
 * If any tool name starts with one of these prefixes, the category
 * gets an extra match equivalent.
 */
const TOOL_NAME_PATTERNS: Record<string, SpecificityCategory> = {
  browser_: 'web_browsing',
  playwright_: 'web_browsing',
  web_: 'web_browsing',
  code_: 'coding',
  editor_: 'coding',
  image_: 'image_generation',
  midjourney_: 'image_generation',
  firefly_: 'image_generation',
  leonardo_: 'image_generation',
  video_: 'video_generation',
  runway_: 'video_generation',
  sora_: 'video_generation',
  social_: 'social_media',
  hootsuite_: 'social_media',
  buffer_: 'social_media',
  email_: 'email_management',
  gmail_: 'email_management',
  outlook_: 'email_management',
  superhuman_: 'email_management',
  calendar_: 'calendar_management',
  gcal_: 'calendar_management',
  calendly_: 'calendar_management',
  reclaim_: 'calendar_management',
  trade_: 'trading',
  exchange_: 'trading',
  robinhood_: 'trading',
  kalshi_: 'trading',
  coinbase_: 'trading',
};

/** Boost applied per matching tool prefix — same as a single strong anchor. */
const TOOL_MATCH_WEIGHT = 3;

/**
 * Session stickiness: if the last few messages all classified as the same
 * category, the session is probably staying in that mode — add a bias so an
 * ambiguous current message keeps the same routing. Size tuned to clearly
 * stabilize a 2h coding session (discussion #1613) without locking it in: a
 * sufficiently strong anchor on the current turn still flips.
 */
const STICKY_AGREEMENT_MIN = 3;
const STICKY_HISTORY_WINDOW = 3;
const STICKY_BIAS = 2;

/**
 * Detect which specificity category (if any) a request belongs to.
 *
 * Scoring is weighted: each keyword match contributes `weightFor(keyword)` to
 * its category, and structural signals (URLs, code fences, file paths, tool
 * names) from `computeSignalBoosts` are added on top. A category activates
 * only if it clears its per-category threshold in ACTIVATION_THRESHOLDS.
 *
 * @param allMatches        Trie matches from the scoring pipeline
 * @param tools             Tool definitions from the request (optional)
 * @param headerOverride    Explicit category from x-manifest-specificity header
 * @param thresholdOverride Uniform threshold override (mainly for tests)
 * @param text              Raw user text used for structural signal detection
 */
export function detectSpecificity(
  allMatches: TrieMatch[],
  tools?: ScorerTool[],
  headerOverride?: string,
  thresholdOverride?: number,
  text?: string,
  recentCategories?: readonly SpecificityCategory[],
  categoryPenalties?: ReadonlyMap<SpecificityCategory, number>,
): SpecificityResult | null {
  if (headerOverride && isValidCategory(headerOverride)) {
    return { category: headerOverride, confidence: 1.0 };
  }

  const scores = new Map<SpecificityCategory, number>();
  for (const cat of SPECIFICITY_CATEGORIES) scores.set(cat, 0);

  // `scores` is pre-seeded above with every SPECIFICITY_CATEGORIES entry, so
  // these lookups are always defined. The non-null helper keeps types honest
  // without a dead `?? 0` branch that coverage tooling cannot exercise.
  const scoreOf = (cat: SpecificityCategory) => scores.get(cat) as number;

  for (const m of allMatches) {
    const cat = dimensionToCategory(m.dimension);
    if (!cat) continue;
    scores.set(cat, scoreOf(cat) + weightFor(m.keyword));
  }

  if (tools && tools.length > 0) {
    applyToolHeuristics(tools, scores);
  }

  if (text && text.length > 0) {
    const { boosts } = computeSignalBoosts(text, tools);
    for (const [cat, v] of boosts) {
      scores.set(cat, scoreOf(cat) + v);
    }
  }

  applySessionBias(scores, recentCategories);

  if (categoryPenalties) {
    for (const [cat, penalty] of categoryPenalties) {
      scores.set(cat, Math.max(0, scoreOf(cat) - penalty));
    }
  }

  let best: SpecificityCategory | null = null;
  let bestScore = 0;

  for (const [cat, score] of scores) {
    const threshold = thresholdOverride ?? ACTIVATION_THRESHOLDS[cat];
    if (score >= threshold && score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }

  if (!best) return null;

  const categoryThreshold = thresholdOverride ?? ACTIVATION_THRESHOLDS[best];
  const confidence = Math.min(bestScore / (categoryThreshold * 3), 1.0);
  return { category: best, confidence };
}

function dimensionToCategory(dimension: string): SpecificityCategory | null {
  for (const cat of SPECIFICITY_CATEGORIES) {
    if (DIMENSION_MAP[cat].includes(dimension)) return cat;
  }
  return null;
}

/**
 * When the last few messages in a session all classified as the same
 * category, add a small bias to that category so an ambiguous current message
 * doesn't flip the routing. Strong anchors on the current turn still win
 * because they produce scores well above the threshold + bias.
 */
function applySessionBias(
  scores: Map<SpecificityCategory, number>,
  recentCategories: readonly SpecificityCategory[] | undefined,
): void {
  if (!recentCategories || recentCategories.length < STICKY_AGREEMENT_MIN) return;

  const window = recentCategories.slice(0, STICKY_HISTORY_WINDOW);
  const first = window[0];
  const allSame = window.every((c) => c === first);
  if (!allSame || window.length < STICKY_AGREEMENT_MIN) return;

  // Map is pre-seeded by the caller with every category; read is always defined.
  scores.set(first, (scores.get(first) as number) + STICKY_BIAS);
}

function applyToolHeuristics(tools: ScorerTool[], scores: Map<SpecificityCategory, number>): void {
  for (const tool of tools) {
    const name = extractToolName(tool);
    if (!name) continue;

    const lower = name.toLowerCase();
    for (const [prefix, category] of Object.entries(TOOL_NAME_PATTERNS)) {
      if (lower.startsWith(prefix)) {
        // Map is pre-seeded by the caller with every category; read is always defined.
        scores.set(category, (scores.get(category) as number) + TOOL_MATCH_WEIGHT);
        break;
      }
    }
  }
}

function isValidCategory(value: string): value is SpecificityCategory {
  return (SPECIFICITY_CATEGORIES as readonly string[]).includes(value);
}
