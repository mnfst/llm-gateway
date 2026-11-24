import { Injectable, Optional } from '@nestjs/common';
import { ModelsDevSyncService } from '../../database/models-dev-sync.service';
import type { ReasoningModelCatalog } from './reasoning-format';

/**
 * Answers "is this a reasoning model?" from the models.dev cache so gateway
 * endpoints don't have to guess the engine behind a slug. Zen's `big-pickle`
 * is a reasoning model no family regex can recognise; `kimi-k2` is a slug that
 * looks like a reasoning family but isn't one.
 *
 * The lookup is synchronous — `ModelsDevSyncService` serves an in-memory map
 * refreshed daily — so it is safe on the forward path. An unknown model
 * returns `undefined`, never `false`: "the catalog is silent" and "the catalog
 * says no" lead to different decisions in `supportsReasoningContent`.
 */
@Injectable()
export class ModelsDevReasoningCatalog implements ReasoningModelCatalog {
  constructor(
    @Optional()
    private readonly modelsDev?: ModelsDevSyncService,
  ) {}

  isReasoningModel(endpointKey: string, model: string): boolean | undefined {
    if (!this.modelsDev) return undefined;

    const normalizedEndpoint = endpointKey.toLowerCase();
    const bare = model.toLowerCase().split('/').pop() ?? '';

    // A custom provider has no models.dev provider id of its own, so fall back
    // to the conservative model-only lookup.
    if (normalizedEndpoint.startsWith('custom:')) {
      return reasoningOf(this.modelsDev.lookupModelAcrossProviders(bare));
    }

    // Aggregators publish ids both ways: OpenRouter keeps the vendor prefix
    // (`deepseek/deepseek-r1`), the OpenCode gateways don't (`glm-5`).
    const prefixed = this.modelsDev.lookupModel(normalizedEndpoint, model.toLowerCase());
    if (prefixed) return reasoningOf(prefixed);
    const scoped = this.modelsDev.lookupModel(normalizedEndpoint, bare);
    if (scoped) return reasoningOf(scoped);

    // A gateway models.dev keys has already given its answer: a miss means the
    // catalog does not know this slug, and staying silent hands the decision to
    // the reasoning-family fallback. Guessing across providers here would let a
    // same-named model under an unrelated maker return a definitive `false` and
    // strip a field the fallback would have kept.
    if (this.modelsDev.isProviderSupported(normalizedEndpoint)) return undefined;

    // Endpoints models.dev does not key at all (OpenRouter) can only ever miss
    // the scoped lookup. Their ids carry the vendor prefix
    // (`deepseek/deepseek-r1`), which the cross-provider lookup resolves against
    // the underlying maker's catalog.
    return reasoningOf(this.modelsDev.lookupModelAcrossProviders(model.toLowerCase()));
  }
}

function reasoningOf(entry: { reasoning?: boolean } | null): boolean | undefined {
  if (!entry) return undefined;
  return entry.reasoning === true;
}
