import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AUTH_TYPES,
  MODEL_CAPABILITIES,
  compareProviderParamSpecs,
  getProviderModelCapabilities,
  getProviderParamSpecs,
  isParamApplicability,
  isProviderParamPath,
  normalizeProviderParamProviderId,
  providerParamValueIsValid,
  resolveProviderMetadataIdentity,
  underlyingGatewayModel,
  type AuthType,
  type JsonValue,
  type ModelCapability,
  type ModelParamDefinition,
  type ModelParamGroup,
  type ModelParamRange,
  type ModelParamType,
  type ProviderModelParamSpec,
  type ProviderParamSpec,
  type ProviderParamSpecCatalog,
} from 'manifest-shared';

const MODELPARAMS_PACKAGE_JSON = 'modelparams/package.json';
const MODELPARAMS_DATA_RELATIVE_PATH = 'dist/generated/data.js';
const MODELPARAMS_API_DEFAULT_URL = 'https://modelparams.dev/api/v1/models.json';
const MODELPARAMS_API_TIMEOUT_MS = 10000;
/** Sanity bound on the buffered payload; today's catalog is ~0.6 MB. */
const MODELPARAMS_API_MAX_BYTES = 16 * 1024 * 1024;
const SUBSCRIPTION_MODEL_SUFFIX = '-subscription';
const SHORT_CLAUDE_MODEL_RE = /^claude-(opus|sonnet|haiku)-/i;
const DOTTED_CLAUDE_MINOR_RE = /-(\d+)\.(\d{1,2})(?=$|-\d{8}$)/g;
const DATE_SUFFIX_RE = /-\d{4}-?\d{2}-?\d{2}$/;
const MODEL_PARAM_TYPES: readonly ModelParamType[] = [
  'boolean',
  'enum',
  'integer',
  'number',
  'string',
];
const MODEL_PARAM_GROUPS: readonly ModelParamGroup[] = [
  'generation_length',
  'sampling',
  'reasoning',
  'tooling',
  'output_format',
  'observability',
  'provider_metadata',
];
const API_LEVEL_PARAM_PATHS = new Set(['stream']);
/** Kimi Code wire ids mapped to their equivalent modelparams catalog entries. */
const MOONSHOT_PARAM_MODEL_ALIASES: Readonly<Record<string, string>> = {
  k3: 'kimi-k3',
  'k3-256k': 'kimi-k3',
  'kimi-for-coding': 'kimi-k2.7-code',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
};

interface ModelParametersApiResponse {
  models?: unknown;
}

interface ProviderlessModelParamCandidate {
  authType: AuthType;
  model: string;
}

const requireFromThisModule = createRequire(__filename);

@Injectable()
export class ProviderParamSpecService implements OnModuleInit {
  private readonly logger = new Logger(ProviderParamSpecService.name);
  /**
   * Seeded synchronously from the bundled modelparams package so the service
   * always has a catalog (offline installs, API outages, cold boots), then
   * kept fresh from the modelparams.dev API.
   */
  private specs: ProviderParamSpecCatalog = loadModelparamsCatalog();
  private catalogEtag: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;

  onModuleInit(): void {
    // Fire-and-forget so a slow modelparams.dev fetch can't delay app.listen()
    // (same rationale as ModelsDevSyncService — see #1894). refreshCatalog
    // never rejects, so no dangling rejection to handle here.
    void this.refreshCatalog();
  }

  /** Hourly, off the top of the hour to avoid stampeding the CDN with every deploy. */
  @Cron('34 * * * *')
  async scheduledRefresh(): Promise<void> {
    await this.refreshCatalog();
  }

  /**
   * Fetch the live catalog from modelparams.dev and swap it in atomically.
   * Conditional on the last ETag (304 = no work), validated before the swap,
   * and stale-on-error: any failure keeps the current catalog. Never rejects.
   * Returns true when a new catalog was applied.
   */
  refreshCatalog(): Promise<boolean> {
    if (process.env.MODELPARAMS_API_DISABLED === 'true') return Promise.resolve(false);
    // Concurrent callers share one in-flight refresh instead of racing the swap.
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.fetchAndSwapCatalog()
      .catch((err: unknown) => {
        this.logger.warn(`modelparams catalog refresh failed, keeping current catalog: ${err}`);
        return false;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  private async fetchAndSwapCatalog(): Promise<boolean> {
    const url = process.env.MODELPARAMS_API_URL ?? MODELPARAMS_API_DEFAULT_URL;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.catalogEtag ? { 'if-none-match': this.catalogEtag } : undefined,
        signal: AbortSignal.timeout(MODELPARAMS_API_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`modelparams catalog fetch failed, keeping current catalog: ${err}`);
      return false;
    }

    if (response.status === 304) return false;
    if (!response.ok) {
      this.logger.warn(
        `modelparams catalog fetch returned ${response.status}, keeping current catalog`,
      );
      return false;
    }

    // Reject an oversized declared payload before buffering it. A chunked or
    // lying response is deliberately left to the 10s AbortSignal (which also
    // bounds body consumption) rather than a streaming byte cap — this is our
    // own CDN, and the simplicity is worth the residual risk.
    if (Number(response.headers.get('content-length')) > MODELPARAMS_API_MAX_BYTES) {
      this.logger.warn(
        `modelparams catalog response declares more than ${MODELPARAMS_API_MAX_BYTES} bytes, keeping current catalog`,
      );
      return false;
    }
    const body = await response.text();

    let raw: unknown;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      this.logger.warn('modelparams catalog response is not valid JSON, keeping current catalog');
      return false;
    }

    const catalog = parseModelParametersCatalog(raw);
    if (!catalog) {
      this.logger.warn('modelparams catalog response failed validation, keeping current catalog');
      return false;
    }

    this.specs = freezeCatalog(catalog);
    this.catalogEtag = response.headers.get('etag');
    this.logger.log(`modelparams catalog refreshed: ${catalog.length} entries`);
    return true;
  }

  async list(): Promise<ProviderParamSpecCatalog> {
    return this.specs;
  }

  /**
   * Lightweight identity list (no params/descriptions) so the Routing page can
   * decide which model rows expose a "configure params" affordance without
   * downloading the whole catalog.
   */
  listModelIds(): Array<{ provider: string; authType: AuthType; model: string }> {
    return this.specs.map((entry) => {
      const provider = normalizeProviderParamProviderId(entry.provider);
      return {
        provider,
        authType: entry.authType,
        model: entry.model,
      };
    });
  }

  async getSpecs(
    providerId: string | undefined,
    authType: AuthType | undefined,
    model: string | undefined,
  ): Promise<readonly ProviderParamSpec[]> {
    const providerlessSpecs = this.getProviderlessSpecs(this.specs, providerId, authType, model);
    if (providerlessSpecs.length > 0) return providerlessSpecs;

    const directSpecs = getProviderParamSpecs(this.specs, providerId, authType, model);
    if (directSpecs.length > 0) return directSpecs;

    const metadata = providerMetadataIdentity(providerId, model);
    if (!metadata || metadataMatchesRoute(metadata, providerId, model)) return directSpecs;

    return getProviderParamSpecs(this.specs, metadata.provider, authType, metadata.model).map(
      (spec) => withRouteIdentity(spec, providerId, authType, model),
    );
  }

  async getCapabilities(
    providerId: string | undefined,
    authType: AuthType | undefined,
    model: string | undefined,
  ): Promise<readonly ModelCapability[] | null> {
    const direct = getProviderModelCapabilities(this.specs, providerId, authType, model);
    if (direct) return direct;

    const metadata = providerMetadataIdentity(providerId, model);
    if (!metadata || metadataMatchesRoute(metadata, providerId, model)) return direct;
    return getProviderModelCapabilities(this.specs, metadata.provider, authType, metadata.model);
  }

  private getProviderlessSpecs(
    specs: ProviderParamSpecCatalog,
    providerId: string | undefined,
    authType: AuthType | undefined,
    model: string | undefined,
  ): readonly ProviderParamSpec[] {
    if (!providerId || !authType || !model || authType === 'local') return [];

    const provider = normalizeProviderParamProviderId(providerId);
    const metadata = resolveParamMetadataIdentity(provider, model);
    const lookupProvider = metadata.provider
      ? normalizeProviderParamProviderId(metadata.provider)
      : provider;
    const candidates = providerlessModelParamCandidates(lookupProvider, authType, metadata.model);
    for (const candidate of candidates) {
      const entry = findProviderlessModelEntry(specs, lookupProvider, candidate);
      if (!entry || entry.params.length === 0) continue;
      return entry.params
        .map((param) => ({ provider, authType, model, ...param }))
        .sort(compareProviderParamSpecs);
    }
    return [];
  }
}

function loadModelparamsCatalog(): ProviderParamSpecCatalog {
  const catalog = parseModelParametersCatalog({ models: loadModelparamsCatalogData() });
  if (!catalog) throw new Error('modelparams package returned an invalid MPS catalog');
  return freezeCatalog(catalog);
}

function loadModelparamsCatalogData(): unknown {
  const packageJsonPath = requireFromThisModule.resolve(MODELPARAMS_PACKAGE_JSON);
  const dataPath = join(dirname(packageJsonPath), MODELPARAMS_DATA_RELATIVE_PATH);
  const dataModule = readFileSync(dataPath, 'utf8');
  // modelparams is ESM-only while the backend is CommonJS, so read the generated
  // JSON-shaped catalog literal directly from the installed package.
  const match = dataModule.match(/export const CATALOG = ([\s\S]*?);\nfunction authSuffix/);
  if (!match) throw new Error('modelparams package catalog file has an unknown shape');
  return JSON.parse(match[1]) as unknown;
}

function providerMetadataIdentity(
  providerId: string | undefined,
  model: string | undefined,
): { provider: string | undefined; model: string } | null {
  if (!model) return null;
  return resolveParamMetadataIdentity(providerId, model);
}

function resolveParamMetadataIdentity(
  providerId: string | undefined,
  model: string,
): { provider: string | undefined; model: string } {
  const normalizedProvider = providerId ? normalizeProviderParamProviderId(providerId) : providerId;
  if (normalizedProvider === 'moonshot') {
    const catalogModel = MOONSHOT_PARAM_MODEL_ALIASES[model.toLowerCase()];
    if (catalogModel) return { provider: normalizedProvider, model: catalogModel };
  }
  return resolveProviderMetadataIdentity(normalizedProvider, model);
}

function metadataMatchesRoute(
  metadata: { provider: string | undefined; model: string },
  providerId: string | undefined,
  model: string | undefined,
): boolean {
  const normalizedProvider = providerId ? normalizeProviderParamProviderId(providerId) : providerId;
  return metadata.provider === normalizedProvider && metadata.model === model;
}

function withRouteIdentity(
  spec: ProviderParamSpec,
  providerId: string | undefined,
  authType: AuthType | undefined,
  model: string | undefined,
): ProviderParamSpec {
  if (!providerId || !authType || !model) return spec;
  return {
    ...spec,
    provider: normalizeProviderParamProviderId(providerId),
    authType,
    model,
  };
}

function providerlessModelParamCandidates(
  providerId: string,
  authType: AuthType,
  model: string,
): readonly ProviderlessModelParamCandidate[] {
  const out: ProviderlessModelParamCandidate[] = [];
  for (const base of providerlessModelBaseCandidates(providerId, model)) {
    for (const variant of providerlessModelSlugVariants(base)) {
      if (authType === 'subscription') {
        pushUniqueCandidate(out, {
          authType: 'subscription',
          model: stripSubscriptionModelSuffix(variant),
        });
        if (!variant.endsWith(SUBSCRIPTION_MODEL_SUFFIX)) {
          pushUniqueCandidate(out, { authType: 'api_key', model: variant });
        }
        continue;
      }
      pushUniqueCandidate(out, { authType, model: variant });
    }
  }
  return out;
}

function findProviderlessModelEntry(
  catalog: ProviderParamSpecCatalog,
  preferredProvider: string,
  candidate: ProviderlessModelParamCandidate,
): ProviderModelParamSpec | null {
  const normalizedProvider = normalizeProviderParamProviderId(preferredProvider);
  return (
    catalog.find(
      (entry) =>
        normalizeProviderParamProviderId(entry.provider) === normalizedProvider &&
        entry.authType === candidate.authType &&
        entry.model === candidate.model,
    ) ??
    catalog.find(
      (entry) => entry.authType === candidate.authType && entry.model === candidate.model,
    ) ??
    null
  );
}

function providerlessModelBaseCandidates(providerId: string, model: string): readonly string[] {
  const out: string[] = [];
  const add = (candidate: string | null | undefined): void => {
    if (!candidate) return;
    if (candidate.includes('/')) {
      const last = candidate.slice(candidate.lastIndexOf('/') + 1);
      pushUnique(out, last);
      return;
    }
    pushUnique(out, candidate);
  };

  add(underlyingGatewayModel(model));
  const normalizedProvider = providerId.toLowerCase();
  if (model.toLowerCase().startsWith(`${normalizedProvider}/`)) {
    add(model.slice(normalizedProvider.length + 1));
  }
  add(model);
  return out;
}

function providerlessModelSlugVariants(model: string): readonly string[] {
  const out: string[] = [];
  const stableModel = stripProviderlessDateSuffix(model);
  for (const candidate of [model, stableModel]) {
    const normalizedClaude = normalizeClaudeProviderlessSlug(candidate);
    pushUnique(out, normalizedClaude);
    pushUnique(out, candidate);
  }
  return out;
}

function normalizeClaudeProviderlessSlug(model: string): string {
  if (!SHORT_CLAUDE_MODEL_RE.test(model)) return model;
  return model.replace(DOTTED_CLAUDE_MINOR_RE, '-$1-$2');
}

function stripProviderlessDateSuffix(model: string): string {
  return model.replace(DATE_SUFFIX_RE, '');
}

function stripSubscriptionModelSuffix(model: string): string {
  if (!model.endsWith(SUBSCRIPTION_MODEL_SUFFIX)) return model;
  return model.slice(0, -SUBSCRIPTION_MODEL_SUFFIX.length);
}

function pushUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) values.push(value);
}

function pushUniqueCandidate(
  values: ProviderlessModelParamCandidate[],
  value: ProviderlessModelParamCandidate,
): void {
  values.push(value);
}

function freezeCatalog(catalog: ProviderParamSpecCatalog): ProviderParamSpecCatalog {
  return Object.freeze(
    catalog
      .filter((entry) => entry.params.length > 0 || (entry.capabilities?.length ?? 0) > 0)
      .map((entry) =>
        Object.freeze({
          ...entry,
          ...(entry.capabilities ? { capabilities: Object.freeze([...entry.capabilities]) } : {}),
          params: Object.freeze([...entry.params].sort(compareProviderParamSpecs)),
        }),
      )
      .sort(compareProviderModelParamSpecs),
  );
}

function parseModelParametersCatalog(raw: unknown): ProviderParamSpecCatalog | null {
  if (!isRecord(raw)) return null;
  const models = (raw as ModelParametersApiResponse).models;
  if (!Array.isArray(models)) return null;

  const catalog: ProviderModelParamSpec[] = [];
  for (const model of models) {
    const entry = parseProviderModelParamSpec(model);
    if (entry) catalog.push(entry);
  }
  return catalog.length > 0 ? catalog : null;
}

function parseProviderModelParamSpec(raw: unknown): ProviderModelParamSpec | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.provider)) return null;
  if (!isAuthType(raw.authType)) return null;
  if (!isNonEmptyString(raw.model)) return null;
  if (raw.params !== undefined && !Array.isArray(raw.params)) return null;
  const capabilities =
    raw.capabilities === undefined ? undefined : parseModelCapabilities(raw.capabilities);
  if (raw.capabilities !== undefined && !capabilities) return null;

  const rawParams = Array.isArray(raw.params) ? raw.params : [];
  const params = rawParams
    .map(parseModelParamDefinition)
    .filter((param): param is ModelParamDefinition => param !== null);

  if (params.length === 0 && (!capabilities || capabilities.length === 0)) return null;
  return {
    provider: raw.provider,
    authType: raw.authType,
    model: raw.model,
    ...(capabilities ? { capabilities } : {}),
    params,
  };
}

function parseModelCapabilities(raw: unknown): readonly ModelCapability[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<ModelCapability>();
  const out: ModelCapability[] = [];
  for (const value of raw) {
    if (!isModelCapability(value)) return null;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseModelParamDefinition(raw: unknown): ModelParamDefinition | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.path) || !isProviderParamPath(raw.path)) return null;
  if (API_LEVEL_PARAM_PATHS.has(raw.path)) return null;
  if (!isModelParamType(raw.type)) return null;
  if (!isNonEmptyString(raw.label)) return null;
  if (!isNonEmptyString(raw.description)) return null;
  if (!isModelParamGroup(raw.group)) return null;
  const range = raw.range === undefined ? undefined : parseRange(raw.range);
  if (raw.range !== undefined && !range) return null;
  const values = raw.values === undefined ? undefined : parseJsonValues(raw.values);
  if (raw.values !== undefined && !values) return null;
  if (raw.type === 'enum' && (!values || values.length === 0)) return null;
  const applicability =
    raw.applicability === undefined
      ? undefined
      : isParamApplicability(raw.applicability)
        ? raw.applicability
        : null;
  if (raw.applicability !== undefined && !applicability) return null;

  const spec: ModelParamDefinition = {
    path: raw.path,
    type: raw.type,
    label: raw.label,
    description: raw.description,
    group: raw.group,
    ...(raw.default !== undefined ? { default: raw.default as JsonValue } : {}),
    ...(values ? { values } : {}),
    ...(range ? { range } : {}),
    ...(applicability ? { applicability } : {}),
  };

  if (raw.default !== undefined && !providerParamValueIsValid(spec, raw.default)) return null;
  return spec;
}

function parseRange(raw: unknown): ModelParamRange | null {
  if (!isRecord(raw)) return null;
  const range: ModelParamRange = {};
  if (raw.min !== undefined) {
    if (!isFiniteNumber(raw.min)) return null;
    range.min = raw.min;
  }
  if (raw.max !== undefined) {
    if (!isFiniteNumber(raw.max)) return null;
    range.max = raw.max;
  }
  if (raw.step !== undefined) {
    if (!isFiniteNumber(raw.step) || raw.step <= 0) return null;
    range.step = raw.step;
  }
  return range;
}

function parseJsonValues(raw: unknown): readonly JsonValue[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  return raw.every(isJsonValue) ? raw : null;
}

function isModelParamType(value: unknown): value is ModelParamType {
  return typeof value === 'string' && MODEL_PARAM_TYPES.includes(value as ModelParamType);
}

function isModelParamGroup(value: unknown): value is ModelParamGroup {
  return typeof value === 'string' && MODEL_PARAM_GROUPS.includes(value as ModelParamGroup);
}

function isAuthType(value: unknown): value is AuthType {
  return typeof value === 'string' && (AUTH_TYPES as readonly string[]).includes(value);
}

function isModelCapability(value: unknown): value is ModelCapability {
  return typeof value === 'string' && (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareProviderModelParamSpecs(
  a: ProviderModelParamSpec,
  b: ProviderModelParamSpec,
): number {
  const providerDelta = a.provider.localeCompare(b.provider);
  if (providerDelta !== 0) return providerDelta;

  const authDelta = a.authType.localeCompare(b.authType);
  if (authDelta !== 0) return authDelta;

  return a.model.localeCompare(b.model);
}
