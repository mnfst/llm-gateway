import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { ProviderService } from '../../routing-core/provider.service';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { scrubSecrets } from '../../../common/utils/secret-scrub';
import { coordinateOAuthRefresh, oauthRefreshKey, subscriptionCredentialLock } from '../core';
import {
  KIRO_CLIENT_NAME,
  KIRO_CLIENT_TYPE,
  KIRO_DEFAULT_SCOPES,
  KIRO_DEFAULT_START_URL,
  KIRO_DEVICE_CODE_GRANT,
  KIRO_OIDC_DEFAULT_REGION,
  KIRO_REFRESH_GRANT,
  KIRO_REGISTER_GRANT_TYPES,
  KiroAuthorizationOptions,
  buildKiroDeviceAuthorizationUrl,
  buildKiroRegisterUrl,
  buildKiroTokenUrl,
  getKiroOidcBaseUrl,
  normalizeKiroRegion,
  normalizeKiroStartUrl,
  parseKiroOAuthTokenBlob,
  serializeKiroOAuthTokenBlob,
  toAbsoluteExpiryTimestamp,
  toPollIntervalMs,
  type KiroOAuthTokenBlob,
} from './kiro-oidc';

interface PendingKiroOAuth {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  agentId: string;
  /** Tenant that owns the agent — the scope the stored credential belongs to. */
  tenantId: string;
  /** Acting user, audit only (tenant_providers.created_by_user_id). */
  createdByUserId: string | null;
  region: string;
  expiresAt: number;
  pollIntervalMs: number;
}

interface KiroRegisterClientResponse {
  clientId?: string;
  clientSecret?: string;
}

interface KiroDeviceAuthorizationResponse {
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
}

interface KiroTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
  error_description?: string;
  message?: string;
}

export interface KiroOAuthStartResult {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  pollIntervalMs: number;
}

export interface KiroOAuthPollResult {
  status: 'pending' | 'success' | 'error';
  message?: string;
  pollIntervalMs?: number;
}

// SSO OIDC `/token` returns HTTP 400 with these error codes while the user has
// not yet approved; they are not failures, just "keep polling" signals.
const PENDING_TOKEN_ERRORS = new Set(['authorization_pending', 'slow_down']);

// RFC 8628 §3.5: on `slow_down` the client MUST increase its polling interval,
// by 5 seconds. Persist the bumped interval so subsequent polls keep backing off.
const SLOW_DOWN_BACKOFF_MS = 5000;

@Injectable()
export class KiroOauthService {
  private readonly logger = new Logger(KiroOauthService.name);
  private readonly pending = new Map<string, PendingKiroOAuth>();
  private readonly region: string;
  private readonly startUrl: string;
  private readonly scopes: readonly string[];

  constructor(
    private readonly providerService: ProviderService,
    private readonly configService: ConfigService,
    private readonly discoveryService: ModelDiscoveryService,
  ) {
    this.region = this.configService.get<string>('KIRO_OIDC_REGION') ?? KIRO_OIDC_DEFAULT_REGION;
    this.startUrl = this.configService.get<string>('KIRO_START_URL') ?? KIRO_DEFAULT_START_URL;
    const scopeOverride = this.configService.get<string>('KIRO_OAUTH_SCOPES');
    this.scopes = scopeOverride
      ? scopeOverride
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean)
      : KIRO_DEFAULT_SCOPES;
  }

  async startAuthorization(
    agentId: string,
    tenantId: string,
    createdByUserId?: string | null,
    options: KiroAuthorizationOptions = {},
  ): Promise<KiroOAuthStartResult> {
    this.cleanupExpired();
    const { region, startUrl } = this.resolveAuthorizationOptions(options);
    const baseUrl = getKiroOidcBaseUrl(region);
    const { clientId, clientSecret } = await this.registerClient(baseUrl);
    const device = await this.startDeviceAuthorization(baseUrl, clientId, clientSecret, startUrl);

    const flowId = randomBytes(16).toString('base64url');
    const expiresAt = toAbsoluteExpiryTimestamp(device.expiresIn);
    const pollIntervalMs = toPollIntervalMs(device.interval);
    this.pending.set(flowId, {
      clientId,
      clientSecret,
      deviceCode: device.deviceCode,
      agentId,
      tenantId,
      createdByUserId: createdByUserId ?? null,
      region,
      expiresAt,
      pollIntervalMs,
    });
    return {
      flowId,
      userCode: device.userCode,
      verificationUri: device.verificationUriComplete || device.verificationUri!,
      expiresAt,
      pollIntervalMs,
    };
  }

  async pollAuthorization(flowId: string, tenantId: string): Promise<KiroOAuthPollResult> {
    // No cleanupExpired() here: it would purge this flow before the per-flow
    // expiry guard below could report it, and the guard is the meaningful
    // check for the flow being polled. Abandoned flows are swept on the next
    // startAuthorization().
    const pending = this.pending.get(flowId);
    if (!pending) {
      return { status: 'error', message: 'Kiro login expired. Start again.' };
    }
    if (pending.tenantId !== tenantId) {
      return { status: 'error', message: 'Kiro login session does not match the current account.' };
    }
    if (Date.now() >= pending.expiresAt) {
      this.pending.delete(flowId);
      return { status: 'error', message: 'Kiro login expired. Start again.' };
    }

    const baseUrl = getKiroOidcBaseUrl(pending.region);
    const response = await fetch(buildKiroTokenUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        grantType: KIRO_DEVICE_CODE_GRANT,
        deviceCode: pending.deviceCode,
      }),
    });
    const payload = await this.parseJson<KiroTokenResponse>(response);

    if (!response.ok) {
      const error = payload?.error ?? '';
      if (PENDING_TOKEN_ERRORS.has(error)) {
        if (error === 'slow_down') {
          // Mutating the pending record (a live Map reference) backs off every
          // subsequent poll, not just this response.
          pending.pollIntervalMs += SLOW_DOWN_BACKOFF_MS;
        }
        return {
          status: 'pending',
          message: 'Waiting for Kiro approval…',
          pollIntervalMs: pending.pollIntervalMs,
        };
      }
      this.pending.delete(flowId);
      return {
        status: 'error',
        message: payload?.error_description ?? payload?.message ?? 'Kiro login failed.',
      };
    }

    if (!payload?.accessToken || !payload.refreshToken || !payload.expiresIn) {
      this.pending.delete(flowId);
      return { status: 'error', message: 'Kiro returned an incomplete token payload.' };
    }

    this.pending.delete(flowId);
    const blob: KiroOAuthTokenBlob = {
      source: 'kiro-oidc',
      t: payload.accessToken,
      r: payload.refreshToken,
      e: toAbsoluteExpiryTimestamp(payload.expiresIn),
      cid: pending.clientId,
      cs: pending.clientSecret,
      region: pending.region,
    };
    const label = await this.providerService.nextOAuthLabel(pending.tenantId, 'kiro');
    const { provider: savedProvider } = await this.providerService.upsertProvider(
      pending.agentId,
      pending.tenantId,
      'kiro',
      serializeKiroOAuthTokenBlob(blob),
      'subscription',
      undefined,
      label,
      pending.createdByUserId,
    );
    try {
      await this.discoveryService.discoverModels(savedProvider);
    } catch (err) {
      this.logger.warn(`Model discovery after Kiro OAuth failed: ${err}`);
    }
    this.logger.log(`Kiro OAuth token stored for agent=${pending.agentId}`);
    return { status: 'success' };
  }

  async unwrapToken(
    rawValue: string,
    agentId: string,
    tenantId: string,
    keyLabel?: string,
  ): Promise<string | null> {
    const blob = parseKiroOAuthTokenBlob(rawValue);
    if (!blob) return null;
    if (Date.now() < blob.e - 60_000) return blob.t;
    try {
      const resolved = await coordinateOAuthRefresh<KiroOAuthTokenBlob>({
        key: oauthRefreshKey('kiro', tenantId, keyLabel),
        logger: this.logger,
        callerBlob: blob,
        parse: parseKiroOAuthTokenBlob,
        refresh: (current) => this.refreshAccessToken(current),
        withLock: subscriptionCredentialLock(
          (t, p, l, fn) => this.providerService.withSubscriptionCredentialLock(t, p, l, fn),
          tenantId,
          'kiro',
          keyLabel,
          serializeKiroOAuthTokenBlob,
        ),
      });
      return resolved.t;
    } catch (err) {
      this.logger.error(`Failed to refresh Kiro OAuth token for agent=${agentId}: ${err}`);
      return Date.now() < blob.e ? blob.t : null;
    }
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private async registerClient(
    baseUrl: string,
  ): Promise<{ clientId: string; clientSecret: string }> {
    const response = await fetch(buildKiroRegisterUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientName: KIRO_CLIENT_NAME,
        clientType: KIRO_CLIENT_TYPE,
        scopes: this.scopes,
        grantTypes: KIRO_REGISTER_GRANT_TYPES,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`Kiro client registration failed: ${text}`);
      throw new Error('Failed to start Kiro login');
    }
    const payload = (await response.json()) as KiroRegisterClientResponse;
    if (!payload.clientId || !payload.clientSecret) {
      throw new Error('Kiro client registration returned an incomplete payload.');
    }
    return { clientId: payload.clientId, clientSecret: payload.clientSecret };
  }

  private async startDeviceAuthorization(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
    startUrl: string,
  ): Promise<
    Required<Pick<KiroDeviceAuthorizationResponse, 'deviceCode' | 'userCode' | 'expiresIn'>> &
      KiroDeviceAuthorizationResponse
  > {
    const response = await fetch(buildKiroDeviceAuthorizationUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl }),
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`Kiro device authorization failed: ${scrubSecrets(text)}`);
      throw new Error('Failed to start Kiro login');
    }
    const payload = (await response.json()) as KiroDeviceAuthorizationResponse;
    if (
      !payload.deviceCode ||
      !payload.userCode ||
      !(payload.verificationUriComplete || payload.verificationUri) ||
      !payload.expiresIn
    ) {
      throw new Error('Kiro device authorization returned an incomplete payload.');
    }
    return payload as Required<
      Pick<KiroDeviceAuthorizationResponse, 'deviceCode' | 'userCode' | 'expiresIn'>
    > &
      KiroDeviceAuthorizationResponse;
  }

  private resolveAuthorizationOptions(
    options: KiroAuthorizationOptions,
  ): Required<KiroAuthorizationOptions> {
    return {
      region: normalizeKiroRegion(options.region ?? this.region),
      startUrl: normalizeKiroStartUrl(options.startUrl ?? this.startUrl),
    };
  }

  private async refreshAccessToken(blob: KiroOAuthTokenBlob): Promise<KiroOAuthTokenBlob> {
    const baseUrl = getKiroOidcBaseUrl(blob.region ?? this.region);
    const response = await fetch(buildKiroTokenUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: blob.cid,
        clientSecret: blob.cs,
        grantType: KIRO_REFRESH_GRANT,
        refreshToken: blob.r,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`Kiro token refresh failed: ${scrubSecrets(text)}`);
      throw new Error('Token refresh failed');
    }
    const payload = (await response.json()) as KiroTokenResponse;
    if (!payload.accessToken || !payload.expiresIn) {
      throw new Error('Kiro token refresh returned an incomplete payload');
    }
    return {
      ...blob,
      t: payload.accessToken,
      r: payload.refreshToken || blob.r,
      e: toAbsoluteExpiryTimestamp(payload.expiresIn),
    };
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [flowId, pending] of this.pending.entries()) {
      if (pending.expiresAt <= now) this.pending.delete(flowId);
    }
  }

  private async parseJson<T>(response: Response): Promise<T | null> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
