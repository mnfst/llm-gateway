import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  CANONICAL_LOCAL_IDS,
  SHARED_PROVIDER_BY_ID_OR_ALIAS,
  deriveCustomProviderAlias,
  isReservedCustomProviderAlias,
  normalizeCustomProviderAlias,
  normalizeProviderName,
} from 'manifest-shared';
import type { AuthType } from 'manifest-shared';
import {
  CustomProvider,
  CustomProviderApiKind,
  CustomProviderModel,
} from '../../entities/custom-provider.entity';
import { ProviderService } from '../routing-core/provider.service';
import { RoutingCacheService } from '../routing-core/routing-cache.service';
import { CreateCustomProviderDto, UpdateCustomProviderDto } from '../dto/custom-provider.dto';
import { validatePublicUrl } from '../../common/utils/url-validation';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { decrypt, getEncryptionSecret } from '../../common/utils/crypto.util';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ModelsDevSyncService } from '../../database/models-dev-sync.service';
import { IngestEventBusService } from '../../common/services/ingest-event-bus.service';
import { classifyProbeError } from './probe-error';

const PROBE_TIMEOUT_MS = 5000;

/**
 * OpenAI-compatible `/v1/models` endpoints return every model the server
 * knows about — including embedding / reranker / moderation models that
 * can't serve `/v1/chat/completions`. LM Studio silently redirects chat
 * calls to its loaded LLM, masking the problem; strict OpenAI-compatible
 * servers reject the call with 400. Either way, surfacing embedders in
 * the routing UI is misleading, so we filter them out at probe time.
 */
const EMBEDDING_MODEL_PATTERN =
  /(?:^|[\/_\-])embed(?:ding|dings|ed)?(?:[\/_\-]|$)|text[_\-]embedding|embedder|reranker|moderation/i;

export function isEmbeddingModel(id: string): boolean {
  return EMBEDDING_MODEL_PATTERN.test(id);
}

/**
 * A custom provider whose display name resolves to a canonical local
 * runner (Ollama, LM Studio) belongs under the Local tab, not API Keys.
 * Used to stamp `auth_type: 'local'` on the companion tenant_providers row
 * so messages routed through it carry the grey-house badge in the UI.
 */
export function isLocalCustomProviderName(name: string): boolean {
  const normalized = normalizeProviderName(name);
  const shared =
    SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
    SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name) ??
    SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
  return !!shared && CANONICAL_LOCAL_IDS.has(shared.id);
}

function authTypeForCustomProvider(name: string): AuthType {
  return isLocalCustomProviderName(name) ? 'local' : 'api_key';
}

const ALIAS_UNIQUE_INDEX = 'IDX_custom_providers_tenant_alias';
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Two requests can both pass the in-memory alias check and race to the
 * partial unique index. TypeORM copies the pg error's `code` and
 * `constraint` onto the QueryFailedError it throws, so the loser is
 * recognisable and gets the same 409 the pre-check would have produced.
 */
function isAliasUniqueViolation(err: unknown): boolean {
  const pg = err as { code?: unknown; constraint?: unknown } | null;
  return pg?.code === PG_UNIQUE_VIOLATION && pg.constraint === ALIAS_UNIQUE_INDEX;
}

@Injectable()
export class CustomProviderService {
  constructor(
    @InjectRepository(CustomProvider)
    private readonly repo: Repository<CustomProvider>,
    private readonly providerService: ProviderService,
    private readonly routingCache: RoutingCacheService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly eventBus: IngestEventBusService,
    @Optional()
    @Inject(ModelsDevSyncService)
    private readonly modelsDevSync: ModelsDevSyncService | null = null,
  ) {}

  /**
   * Custom providers are tenant-global, so a create/update/delete from one agent
   * changes the list every other agent sees. Emit a `routing` SSE so
   * already-open clients (sibling agents, other tabs) drop their cached
   * custom-provider list instead of showing stale data until a full reload.
   * The bus is tenant-keyed; the acting user's id rides along as attribution.
   */
  private notifyChange(tenantId: string, actorUserId?: string | null): void {
    this.eventBus.emit(tenantId, 'routing', actorUserId);
  }

  /**
   * Reject an explicit alias that would shadow a built-in provider route or
   * another custom provider of the tenant (case-insensitive, like the name).
   */
  private assertAliasAvailable(
    alias: string,
    allForTenant: CustomProvider[],
    excludeId?: string,
  ): void {
    if (isReservedCustomProviderAlias(alias)) {
      throw new BadRequestException(`Alias "${alias}" is reserved for a built-in provider`);
    }
    const dup = allForTenant.find((r) => r.id !== excludeId && r.alias?.toLowerCase() === alias);
    if (dup) {
      throw new ConflictException(`Alias "${alias}" is already used by "${dup.name}"`);
    }
  }

  /** Default alias for a new provider: derived from the name, or none when taken. */
  private defaultAlias(name: string, allForTenant: CustomProvider[]): string | null {
    const derived = deriveCustomProviderAlias(name);
    if (!derived) return null;
    return allForTenant.some((r) => r.alias?.toLowerCase() === derived) ? null : derived;
  }

  /** Provider key used in TenantProvider tables. */
  static providerKey(id: string): string {
    return `custom:${id}`;
  }

  /** Unique model name for model lookups. */
  static modelKey(id: string, modelName: string): string {
    return `custom:${id}/${modelName}`;
  }

  /** Strip the custom prefix to get the raw model name for upstream API. */
  static rawModelName(prefixedName: string): string {
    const slash = prefixedName.indexOf('/');
    return slash !== -1 ? prefixedName.substring(slash + 1) : prefixedName;
  }

  /** Check if a provider key is a custom provider. */
  static isCustom(provider: string): boolean {
    return provider.startsWith('custom:');
  }

  /** Extract the custom provider UUID from a provider key. */
  static extractId(providerKey: string): string {
    return providerKey.replace('custom:', '');
  }

  /**
   * If `name` matches a `tileOnly: true` canonical provider from the shared
   * registry (llama.cpp → `llamacpp`, LM Studio → `lmstudio`), return that
   * canonical id. Otherwise return null. Used to surface tile-connected
   * local servers as first-class providers in user-visible columns
   * (`agent_messages.provider` / `.model`, dashboard aggregations) even
   * though they're physically stored in `custom_providers`.
   */
  static canonicalTileIdForName(name: string): string | null {
    const entry = SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName(name));
    return entry?.tileOnly ? entry.id : null;
  }

  /**
   * Rewrite a `(provider, model)` pair for the agent_messages log. When the
   * pair resolves to a tile-connected canonical provider, substitute the
   * canonical id so the DB / dashboard never exposes the internal
   * `custom:<uuid>` key. Passthrough for every other case (non-custom
   * providers, and user-defined custom providers that don't match a
   * tile-only canonical).
   */
  // Overloads: narrow the output model type to whatever nullability the
  // caller passed in for the input model. When `model` is a non-null
  // string the rewrite path can only ever produce a non-null string, so
  // downstream call sites don't need defensive `?? model` fallbacks.
  async canonicalizeAgentMessageKeys(
    tenantId: string,
    provider: string | null | undefined,
    model: string,
  ): Promise<{ provider: string | null; model: string }>;
  async canonicalizeAgentMessageKeys(
    tenantId: string,
    provider: string | null | undefined,
    model: string | null | undefined,
  ): Promise<{ provider: string | null; model: string | null }>;
  async canonicalizeAgentMessageKeys(
    tenantId: string,
    provider: string | null | undefined,
    model: string | null | undefined,
  ): Promise<{ provider: string | null; model: string | null }> {
    const providerIsCustom = !!provider && CustomProviderService.isCustom(provider);
    const modelMatch = model?.match(/^custom:([^/]+)\//);
    if (!providerIsCustom && !modelMatch) {
      return { provider: provider ?? null, model: model ?? null };
    }

    // Pick the UUID to look up: prefer the provider string, fall back to
    // the `custom:<uuid>/` prefix on the model (fallback_from_model is the
    // only place where we see a custom model without a matching provider
    // on the same row).
    const cpId = providerIsCustom
      ? CustomProviderService.extractId(provider!)
      : (modelMatch?.[1] ?? null);
    if (!cpId) return { provider: provider ?? null, model: model ?? null };

    const rows = await this.list(tenantId);
    const row = rows.find((r) => r.id === cpId);
    if (!row) return { provider: provider ?? null, model: model ?? null };

    const canonical = CustomProviderService.canonicalTileIdForName(row.name);
    if (!canonical) return { provider: provider ?? null, model: model ?? null };

    const rewrittenProvider = providerIsCustom ? canonical : (provider ?? null);
    const rewrittenModel =
      model && model.startsWith(`custom:${cpId}/`)
        ? `${canonical}/${CustomProviderService.rawModelName(model)}`
        : (model ?? null);
    return { provider: rewrittenProvider, model: rewrittenModel };
  }

  async list(tenantId: string): Promise<CustomProvider[]> {
    const cached = this.routingCache.getCustomProviders(tenantId);
    if (cached) return cached;

    const result = await this.repo.find({ where: { tenant_id: tenantId } });
    this.routingCache.setCustomProviders(tenantId, result);
    return result;
  }

  async create(
    tenantId: string,
    dto: CreateCustomProviderDto,
    createdByUserId?: string | null,
  ): Promise<CustomProvider> {
    // Use case-insensitive comparison to match the DB unique index on
    // (tenant_id, LOWER(name)) — an exact findOne would miss "My Provider"
    // vs "my provider" and fall through to a raw constraint 500.
    const allForTenant = await this.repo.find({ where: { tenant_id: tenantId } });
    const existing = allForTenant.find((r) => r.name.toLowerCase() === dto.name.toLowerCase());
    if (existing) {
      throw new ConflictException(`Custom provider "${dto.name}" already exists`);
    }

    // An omitted alias gets a default derived from the name, silently left
    // empty when that default is unusable or taken — the user can set one
    // later. An explicit alias (including null, meaning "none") is honoured
    // as sent and validated like the name is.
    const alias =
      dto.alias === undefined
        ? this.defaultAlias(dto.name, allForTenant)
        : normalizeCustomProviderAlias(dto.alias);
    if (alias && dto.alias !== undefined) this.assertAliasAvailable(alias, allForTenant);

    try {
      await validatePublicUrl(dto.base_url, { allowPrivate: isSelfHosted() });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const id = randomUUID();
    const provKey = CustomProviderService.providerKey(id);

    const cp = Object.assign(new CustomProvider(), {
      id,
      tenant_id: tenantId,
      created_by_user_id: createdByUserId ?? null,
      name: dto.name,
      alias,
      base_url: dto.base_url,
      api_kind: dto.api_kind ?? 'openai',
      models: this.enrichCustomProviderModels(dto.name, dto.models),
      created_at: new Date().toISOString(),
    });
    // A custom provider is two rows that must exist together: the
    // custom_providers config row and its companion tenant_providers row
    // (provider = 'custom:<id>', FK-backed via the generated
    // custom_provider_id column). Insert both in ONE transaction so a failed
    // companion insert can't strand a custom_providers row that squats the
    // name while being invisible to routing.
    //
    // Inside the transaction: create TenantProvider + enable it for every
    // owned agent (custom providers are tenant-global). When the display name
    // resolves to Ollama / LM Studio we tag the row `'local'` so routed
    // messages carry the grey-house badge and the row shows up under the
    // Local tab. A null agentId tells the provider service the change is
    // tenant-global rather than tied to one agent.
    try {
      await this.repo.manager.transaction(async (manager) => {
        await manager.getRepository(CustomProvider).insert(cp);
        await this.providerService.upsertProvider(
          null,
          tenantId,
          provKey,
          dto.apiKey,
          authTypeForCustomProvider(dto.name),
          undefined,
          undefined,
          createdByUserId,
          manager,
        );
      });
    } catch (err) {
      if (isAliasUniqueViolation(err)) {
        throw new ConflictException(`Alias "${alias}" is already used by another provider`);
      }
      throw err;
    }

    // Rebuild the shared pricing cache so the proxy can compute cost for
    // requests routed to this custom provider's models immediately (without
    // waiting for the daily 5am reload).
    await this.pricingCache.reload();

    this.notifyChange(tenantId, createdByUserId);
    return cp;
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateCustomProviderDto,
    actorUserId?: string | null,
  ): Promise<CustomProvider> {
    const cp = await this.repo.findOne({ where: { id, tenant_id: tenantId } });
    if (!cp) {
      throw new NotFoundException('Custom provider not found');
    }

    const previousName = cp.name;
    if (dto.name !== undefined && dto.name !== cp.name) {
      // Use case-insensitive comparison to match the DB unique index on
      // (tenant_id, LOWER(name)) so "My Provider" → "my provider" returns
      // a ConflictException instead of hitting a raw DB constraint 500.
      const allForTenant = await this.repo.find({ where: { tenant_id: tenantId } });
      const dup = allForTenant.find(
        (r) => r.id !== id && r.name.toLowerCase() === dto.name!.toLowerCase(),
      );
      if (dup) {
        throw new ConflictException(`Custom provider "${dto.name}" already exists`);
      }
      cp.name = dto.name;
    }

    // Renaming never touches the alias: client configs carry
    // `<alias>/<model>` and must survive a display-name change. Only an
    // explicit alias field changes it (null or '' clears it).
    if (dto.alias !== undefined) {
      const alias = normalizeCustomProviderAlias(dto.alias);
      if (alias && alias !== cp.alias) {
        const allForTenant = await this.repo.find({ where: { tenant_id: tenantId } });
        this.assertAliasAvailable(alias, allForTenant, id);
      }
      cp.alias = alias;
    }

    if (dto.base_url !== undefined) {
      try {
        await validatePublicUrl(dto.base_url, { allowPrivate: isSelfHosted() });
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
      cp.base_url = dto.base_url;
    }

    if (dto.api_kind !== undefined) {
      cp.api_kind = dto.api_kind;
    }

    if (dto.models !== undefined) {
      cp.models = this.enrichCustomProviderModels(cp.name, dto.models);
    }

    try {
      await this.repo.save(cp);
    } catch (err) {
      if (isAliasUniqueViolation(err)) {
        throw new ConflictException(`Alias "${cp.alias}" is already used by another provider`);
      }
      throw err;
    }
    // Fans out to the discovered-model cache of every agent in the tenant, so
    // an alias or model-list edit shows in /v1/models on the next request.
    this.routingCache.invalidateTenant(tenantId);

    // Reload pricing cache when the model list changes so explicit routes to
    // these models have fresh cost metadata.
    if (dto.models !== undefined) {
      await this.pricingCache.reload();
    }

    // Retag auth_type when the name changes categories (freeform ↔ canonical
    // local). This path fires even without an apiKey update because renaming
    // "LM Studio" to "My Home Server" should move the row off the Local tab,
    // and the reverse should light up the grey-house badge.
    const nextAuthType = authTypeForCustomProvider(cp.name);
    const nameCategoryChanged =
      previousName !== cp.name && authTypeForCustomProvider(previousName) !== nextAuthType;

    // Update API key if explicitly provided. Preserve the auth_type
    // derived from the (possibly renamed) display name so toggling between
    // "LM Studio" ↔ a freeform name re-tags the companion tenant_providers
    // row accordingly.
    if ('apiKey' in dto) {
      await this.providerService.upsertProvider(
        null,
        tenantId,
        CustomProviderService.providerKey(id),
        dto.apiKey,
        nextAuthType,
        undefined,
        undefined,
        actorUserId,
      );
    } else if (nameCategoryChanged) {
      // Rename-only path: flip auth_type in place so the row keeps its
      // stored api_key_encrypted and tier overrides stay intact. Going
      // through upsertProvider would insert a second row since the unique
      // index is keyed on (tenant_id, provider, auth_type).
      await this.providerService.retagAuthType(
        null,
        tenantId,
        CustomProviderService.providerKey(id),
        nextAuthType,
      );
    }

    this.notifyChange(tenantId, actorUserId);
    return cp;
  }

  async remove(tenantId: string, id: string, actorUserId?: string | null): Promise<void> {
    const cp = await this.repo.findOne({ where: { id, tenant_id: tenantId } });
    if (!cp) {
      throw new NotFoundException('Custom provider not found');
    }

    const provKey = CustomProviderService.providerKey(id);

    // Tear down both rows in ONE transaction so a failure between them can't
    // leave a custom provider listed without its companion tenant_providers row
    // (or vice versa). The DB-level FK on tenant_providers.custom_provider_id
    // additionally cascade-deletes any companion row the application pass
    // missed once the custom_providers row goes.
    await this.repo.manager.transaction(async (manager) => {
      // Remove the tenant-global TenantProvider. ProviderService blocks removal
      // while any explicit routes still point at this custom provider.
      // A null agentId tells the provider service the removal is tenant-global.
      try {
        await this.providerService.removeProvider(
          null,
          tenantId,
          provKey,
          undefined,
          undefined,
          manager,
        );
      } catch (err) {
        // Provider may not exist if creation partially failed; every other
        // failure (notably "provider is still routed") must block deletion.
        if (!(err instanceof NotFoundException)) throw err;
      }

      // Delete CustomProvider row
      await manager.getRepository(CustomProvider).remove(cp);
    });

    // Drop the now-deleted provider from the tenant-scoped custom-provider cache
    // so a subsequent list() doesn't serve it from a warm cache (mirrors update).
    this.routingCache.invalidateTenant(tenantId);

    // Drop stale pricing entries for this provider's models from the cache.
    await this.pricingCache.reload();

    this.notifyChange(tenantId, actorUserId);
  }

  async getById(id: string, tenantId: string): Promise<CustomProvider | null> {
    // Tenant-scoped to match list/update/remove — a bare `{ id }` lookup would
    // let one tenant read another's custom provider row if a caller ever passed
    // an attacker-controlled id. No in-repo callers today; scoped defensively.
    return this.repo.findOne({ where: { id, tenant_id: tenantId } });
  }

  /**
   * Probes the `/models` endpoint of a custom provider and returns the
   * discovered model IDs. Used by the "Fetch models" button in the form so
   * users don't have to type each model name by hand. Both OpenAI's
   * `GET {base}/models` and Anthropic's `GET {base}/v1/models` return a
   * `{ data: [{ id }] }` shape — we only need to vary the path and the
   * auth header scheme.
   */
  async probeModels(
    baseUrl: string,
    apiKey?: string,
    apiKind: CustomProviderApiKind = 'openai',
    providerName?: string,
  ): Promise<CustomProviderModel[]> {
    try {
      await validatePublicUrl(baseUrl, { allowPrivate: isSelfHosted() });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // Trim trailing slashes without a regex to avoid polynomial backtracking
    // on adversarial input (CodeQL js/polynomial-redos).
    let end = baseUrl.length;
    while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* '/' */) end--;
    const trimmed = baseUrl.slice(0, end);
    const url = apiKind === 'anthropic' ? `${trimmed}/v1/models` : `${trimmed}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKind === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (apiKey) headers['x-api-key'] = apiKey;
      } else if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      // User-controlled URL is intentional here — this endpoint exists to
      // connect to operator-chosen LLM servers. validatePublicUrl() above is
      // our SSRF mitigation: cloud metadata is always blocked, private IPs
      // only accepted in the self-hosted version. `redirect: 'error'`
      // ensures a hostile server can't redirect the probe to a destination
      // that would bypass validation.
      // codeql[js/request-forgery]
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        throw new BadRequestException(classifyProbeError({ url, status: res.status }).message);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new BadRequestException(classifyProbeError({ url, contentType }).message);
      }
      const body = (await res.json()) as { data?: { id?: string }[] };
      const items = body?.data ?? [];
      const filtered = items.filter(
        (m): m is { id: string } =>
          typeof m.id === 'string' && m.id.length > 0 && !isEmbeddingModel(m.id),
      );
      return this.enrichCustomProviderModels(
        providerName,
        filtered.map((m) => ({ model_name: m.id })),
        { defaultContextWindow: false },
      );
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(classifyProbeError({ url, error: err as Error }).message);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Look up the encrypted API key for an existing custom provider row and
   * decrypt it for server-side use. Returns undefined on any miss (no row,
   * null ciphertext, or corrupt blob) so callers fall back to an
   * unauthenticated request — the upstream response then drives error
   * classification. Tenant-scoped to prevent cross-tenant key exfiltration
   * via a forged providerId.
   *
   * Used by the probe controller: the edit form never has the plaintext key
   * (list() only exposes `has_api_key:bool`), so when the user hasn't
   * re-typed one we decrypt the stored key for a single in-flight probe.
   */
  async loadStoredApiKey(tenantId: string, providerId: string): Promise<string | undefined> {
    const provKey = CustomProviderService.providerKey(providerId);
    const tenantProviders = await this.providerService.getProviders(tenantId);
    const row = tenantProviders.find((p) => p.provider === provKey);
    if (!row?.api_key_encrypted) return undefined;
    try {
      return decrypt(row.api_key_encrypted, getEncryptionSecret());
    } catch {
      return undefined;
    }
  }

  private enrichCustomProviderModels(
    providerName: string | undefined,
    models: readonly CustomProviderModel[],
    options: { defaultContextWindow?: boolean } = {},
  ): CustomProviderModel[] {
    return models.map((model) => {
      const modelsDevMatch =
        providerName && this.modelsDevSync
          ? this.modelsDevSync.lookupCustomProviderModel(providerName, model.model_name)
          : null;
      const modelOnlyMatch =
        !modelsDevMatch && this.modelsDevSync
          ? ((this.modelsDevSync as Partial<ModelsDevSyncService>).lookupModelAcrossProviders?.(
              model.model_name,
            ) ?? null)
          : null;
      const priceSource = modelsDevMatch ?? modelOnlyMatch;
      const inputWasFilled =
        model.input_price_per_million_tokens == null && priceSource?.inputPricePerToken != null;
      const outputWasFilled =
        model.output_price_per_million_tokens == null && priceSource?.outputPricePerToken != null;
      const inputPrice =
        model.input_price_per_million_tokens ??
        this.toPricePerMillion(priceSource?.inputPricePerToken);
      const outputPrice =
        model.output_price_per_million_tokens ??
        this.toPricePerMillion(priceSource?.outputPricePerToken);
      const contextWindow =
        model.context_window ??
        priceSource?.contextWindow ??
        (options.defaultContextWindow === false ? undefined : 128000);
      const priceEstimated =
        !modelsDevMatch &&
        (inputPrice !== undefined || outputPrice !== undefined) &&
        (model.price_estimated === true || inputWasFilled || outputWasFilled);

      const enriched: CustomProviderModel = {
        model_name: model.model_name,
      };
      if (inputPrice !== undefined) enriched.input_price_per_million_tokens = inputPrice;
      if (outputPrice !== undefined) enriched.output_price_per_million_tokens = outputPrice;
      if (contextWindow !== undefined) enriched.context_window = contextWindow;
      if (priceEstimated) enriched.price_estimated = true;
      return enriched;
    });
  }

  private toPricePerMillion(pricePerToken: number | null | undefined): number | undefined {
    if (pricePerToken == null) return undefined;
    return Number((pricePerToken * 1_000_000).toFixed(12));
  }
}
