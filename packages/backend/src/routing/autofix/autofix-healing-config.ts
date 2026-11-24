/**
 * The one hosted Phoenix every deployment heals against. This is a constant,
 * not an operator knob: cloud and self-hosted talk to the same service, and the
 * only thing that differs is how they authenticate (a static
 * `AUTOFIX_HEALING_API_KEY` for cloud, the anonymous install id for
 * self-hosted). Pointing an install at some other healer is not a supported
 * configuration, so there is no URL to typo, to redirect, or to leak a key to.
 */
export const AUTOFIX_URL = 'https://autofix.manifest.build';

/**
 * Resolve the healer URL for the running environment.
 *
 * Production — cloud or self-hosted — always gets hosted Phoenix. Dev and test
 * get `undefined` so the caller selects the deterministic in-process mock: a
 * developer running the stack locally must never post real failures at the
 * production healer, and a test must never depend on the network.
 *
 * To switch Autofix off entirely, set `AUTOFIX_GLOBAL_ENABLED=false`; that
 * short-circuits in `AutofixService` before any heal call is made.
 */
export function resolveHealingUrl(nodeEnv: string | undefined): string | undefined {
  return nodeEnv === 'production' ? AUTOFIX_URL : undefined;
}
