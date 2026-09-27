import { resolveProviderMetadataIdentity, underlyingGatewayModel } from 'manifest-shared';

export interface MetadataIdentity {
  provider: string | undefined;
  model: string;
}

/**
 * The identities to try, in order, when reading a model's metadata (display
 * name, capability flags, modalities, pricing) out of models.dev.
 *
 * A gateway id resolves to the underlying vendor first: the gateway proxies
 * that vendor's model, so the vendor's own catalog is the primary source and
 * `opencode-zen/claude-opus-5` keeps reading Anthropic's entry.
 *
 * The gateway's own catalog is the fallback, because a gateway also serves ids
 * the vendor never published. OpenCode Go serves `deepseek-v4.1-flash` while
 * DeepSeek's own catalog calls that model `deepseek-flash`, so the vendor
 * lookup misses and — before this fallback existed — the model resolved to no
 * metadata at all: the picker printed the raw id instead of a name and the
 * capability badges went missing. models.dev lists these gateways as providers
 * in their own right, keyed by the exact ids they serve.
 */
export function metadataIdentities(provider: string, modelId: string): MetadataIdentity[] {
  const primary = resolveProviderMetadataIdentity(provider, modelId);
  const bare = underlyingGatewayModel(modelId);
  if (bare === null) return [primary];
  if ((primary.provider ?? provider) === provider && primary.model === bare) return [primary];
  return [primary, { provider, model: bare }];
}

/**
 * Resolve a model's metadata entry, walking `metadataIdentities` until a
 * catalog lookup hits. Returns the identity that produced the entry so callers
 * can keep using it for the lookups models.dev does not answer (curated
 * modalities, the streaming heuristic). When nothing matches, the primary
 * identity is returned with a null entry — the pre-existing behaviour.
 */
export function resolveMetadataEntry<T>(
  provider: string,
  modelId: string,
  lookup: (providerId: string, modelId: string) => T | null | undefined,
): { metadata: MetadataIdentity; entry: T | null } {
  const candidates = metadataIdentities(provider, modelId);
  for (const metadata of candidates) {
    const entry = lookup(metadata.provider ?? provider, metadata.model);
    // Only absence counts as a miss: `T` may legitimately be falsy.
    if (entry != null) return { metadata, entry };
  }
  return { metadata: candidates[0], entry: null };
}
