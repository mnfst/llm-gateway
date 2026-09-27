/**
 * Configuration for a Manifest-managed free provider backed by LiteLLM.
 *
 * To add another free provider, copy the Gemini Free entry below and change
 * its identity, LiteLLM model group, catalog prefix, filter, and budget env.
 * Provisioning, discovery, routing, and connection limits consume this config.
 */
export interface ManagedFreeProviderConfig {
  id: string;
  displayName: string;
  litellmModels: readonly string[];
  catalogModelIdPrefix: string;
  preferredModelIdPrefix: string;
  nonChatModelPattern: RegExp;
  maxBudgetEnvVar: string;
}

export const MANAGED_FREE_PROVIDER_CONFIGS: readonly ManagedFreeProviderConfig[] = [
  {
    id: 'gemini-free',
    displayName: 'Gemini Free',
    litellmModels: ['gemini/*'],
    catalogModelIdPrefix: 'gemini-',
    preferredModelIdPrefix: 'gemini/',
    nonChatModelPattern:
      /(?:\*|(?:^|\/)aqs-|nano-banana|deep-research|computer-use|lyria|veo-|native-audio|audio-preview|image-generation|(?:^|\/)imagen|-image(?:$|-|\/)|live-preview|(?:^|\/|-)live-|embedding|robotics|tts|gemini-1\.5|gemini-2\.0-flash-001|gemini-2\.0-flash-lite|flash-lite-preview-\d|\/gemini-exp-|-exp-\d|learnlm|gemma-|omni-flash|customtools)/i,
    maxBudgetEnvVar: 'CREDITS_GEMINI_FREE_MAX_BUDGET',
  },
];

export const MANAGED_FREE_PROVIDER_BY_ID: ReadonlyMap<string, ManagedFreeProviderConfig> = new Map(
  MANAGED_FREE_PROVIDER_CONFIGS.map((config) => [config.id, config]),
);

export function getManagedFreeProviderConfig(
  providerId: string,
): ManagedFreeProviderConfig | undefined {
  return MANAGED_FREE_PROVIDER_BY_ID.get(providerId.toLowerCase());
}

const DEFAULT_CREDITS_BASE_URL = 'https://credits.manifest.build';
const DEFAULT_MAX_BUDGET_USD = 10;

export function getManagedFreeLiteLlmBaseUrl(): string {
  const raw = process.env['CREDITS_BASE_URL']?.trim() || DEFAULT_CREDITS_BASE_URL;
  return raw.replace(/\/+$/, '');
}

export function getManagedFreeLiteLlmMasterKey(): string | null {
  const key = process.env['CREDITS_MASTER_KEY']?.trim();
  return key && key.length > 0 ? key : null;
}

export function getManagedFreeLiteLlmMaxBudgetUsd(config: ManagedFreeProviderConfig): number {
  const raw = process.env[config.maxBudgetEnvVar]?.trim();
  if (!raw) return DEFAULT_MAX_BUDGET_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_BUDGET_USD;
}

/** Comma-separated emails. Empty means any user is eligible when a master key is configured. */
export function getManagedFreeLiteLlmAutoAllowlist(): string[] {
  const raw = process.env['CREDITS_AUTO_PROVISION_ALLOWLIST']?.trim() ?? '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isManagedFreeLiteLlmAutoEligible(email: string | null | undefined): boolean {
  if (!getManagedFreeLiteLlmMasterKey()) return false;
  const allowlist = getManagedFreeLiteLlmAutoAllowlist();
  if (allowlist.length === 0) return true;
  if (!email) return false;
  return allowlist.includes(email.trim().toLowerCase());
}

export function getManagedFreeLiteLlmModelsUrl(): string {
  return `${getManagedFreeLiteLlmBaseUrl()}/v1/models`;
}

export function getManagedFreeLiteLlmKeyGenerateUrl(): string {
  return `${getManagedFreeLiteLlmBaseUrl()}/key/generate`;
}
