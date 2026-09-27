import { SHARED_PROVIDER_BY_ID_OR_ALIAS } from './providers';

/**
 * A custom provider's alias is the first path segment of the model ids
 * `/v1/models` publishes for it (`<alias>/<model_name>`), so it must be a
 * valid segment: lowercase letters, digits, dots and hyphens, with no
 * leading, trailing or doubled separators.
 */
export const CUSTOM_PROVIDER_ALIAS_MAX_LENGTH = 50;
export const CUSTOM_PROVIDER_ALIAS_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const CUSTOM_PROVIDER_ALIAS_MESSAGE =
  'Alias can only contain lowercase letters, numbers, dots and hyphens, and cannot start or end with a separator';

/**
 * Aliases that would collide with another published route: the synthetic
 * `auto` route, Manifest itself, the internal `custom:` prefix, and every
 * built-in provider id or alias (`openai/gpt-4o` must keep meaning OpenAI).
 * Tile-only local providers (llama.cpp, LM Studio) are exempt: they only
 * ever exist as custom providers, so no native route can claim the name.
 */
const RESERVED_ALIASES: ReadonlySet<string> = new Set(['auto', 'manifest', 'custom']);

/** Trim and lowercase user input; an empty value means "no alias". */
export function normalizeCustomProviderAlias(input: string | null | undefined): string | null {
  const normalized = input?.trim().toLowerCase() ?? '';
  return normalized === '' ? null : normalized;
}

export function isReservedCustomProviderAlias(alias: string): boolean {
  if (RESERVED_ALIASES.has(alias)) return true;
  const entry = SHARED_PROVIDER_BY_ID_OR_ALIAS.get(alias);
  return entry !== undefined && !entry.tileOnly;
}

/**
 * Derive the default alias from a display name: `Vercel AI Gateway` →
 * `vercel-ai-gateway`, `llama.cpp` → `llama.cpp`. Returns null when the
 * name yields nothing usable or a reserved alias, in which case the
 * provider keeps publishing under its internal `custom:<uuid>/…` id.
 */
export function deriveCustomProviderAlias(name: string): string | null {
  const collapsed = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/[.-]{2,}/g, (run) => run[0]);
  const derived = trimSeparators(
    trimSeparators(collapsed).slice(0, CUSTOM_PROVIDER_ALIAS_MAX_LENGTH),
  );
  if (!CUSTOM_PROVIDER_ALIAS_PATTERN.test(derived)) return null;
  if (isReservedCustomProviderAlias(derived)) return null;
  return derived;
}

/**
 * Strip leading and trailing `.` / `-`. A loop rather than `/[.-]+$/`: that
 * anchored-suffix regex backtracks polynomially on long separator runs, and
 * the input here is a user-supplied name.
 */
function trimSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSeparator(value[start])) start++;
  while (end > start && isSeparator(value[end - 1])) end--;
  return value.slice(start, end);
}

function isSeparator(char: string): boolean {
  return char === '.' || char === '-';
}
