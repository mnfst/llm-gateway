/**
 * Shared base for redirect-PKCE OAuth providers (OpenAI, Gemini, …).
 *
 * Subclasses inject a `RedirectPkceOauthConfig` describing the provider's
 * URLs / scopes / client id; the base owns the loopback callback server,
 * PKCE state, token exchange, refresh, revoke, and the `unwrap` helper
 * that the proxy uses to lazily refresh access tokens before forwarding.
 *
 * The original implementation lived inline in `openai-oauth.service.ts`.
 * Extracted here so a second redirect-PKCE provider does not require
 * duplicating ~250 lines of OAuth boilerplate.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { ProviderService } from '../../routing-core/provider.service';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { scrubSecrets } from '../../../common/utils/secret-scrub';
import { generatePkce, generateState } from './pkce';
import { oauthDoneHtml } from './callback-page';
import { PendingStore } from './pending-store';
import { parseOAuthTokenBlob, serializeOAuthTokenBlob, type OAuthTokenBlob } from './oauth-blob';
import {
  coordinateOAuthRefresh,
  oauthRefreshKey,
  subscriptionCredentialLock,
} from './oauth-refresh-coordinator';

export interface RedirectPkceOauthConfig {
  /** Provider id stored on `tenant_providers.provider_id`. */
  readonly providerId: string;
  /** Logger label used by the subclass. */
  readonly serviceName: string;
  /** Default OAuth client id (used when the env override is absent). */
  readonly defaultClientId: string;
  /** Optional default client secret. Some providers (Google) require one. */
  readonly defaultClientSecret?: string;
  /** Env var that overrides `defaultClientId`. */
  readonly clientIdEnvVar: string;
  /** Optional env var that overrides `defaultClientSecret`. */
  readonly clientSecretEnvVar?: string;
  /** OAuth authorize endpoint. */
  readonly authorizeUrl: string;
  /** OAuth token endpoint (authorization_code + refresh_token). */
  readonly tokenUrl: string;
  /** Optional revoke endpoint. When absent, `revokeToken` is a no-op. */
  readonly revokeUrl?: string;
  /** Scope string sent in the authorize request. */
  readonly scope: string;
  /** Loopback port the dev callback server binds. */
  readonly callbackPort: number;
  /**
   * Extra params merged into the authorize URL. Useful for provider quirks
   * (Google requires `access_type=offline&prompt=consent` to receive a
   * refresh token).
   */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
  /**
   * Full redirect URI override. Defaults to
   * `http://localhost:<callbackPort>/auth/callback`; xAI registers
   * `http://127.0.0.1:<port>/callback` instead.
   */
  readonly redirectUri?: string;
  /** Path the loopback callback server answers on. Default `/auth/callback`. */
  readonly callbackPath?: string;
  /** Send an OIDC `nonce` in the authorize request (xAI requires one). */
  readonly includeNonce?: boolean;
  /**
   * Extra headers merged into token-endpoint requests (exchange, refresh,
   * revoke). xAI's endpoints expect `Accept: application/json`.
   */
  readonly extraTokenHeaders?: Readonly<Record<string, string>>;
  /** Heading shown on the fallback "you can close this tab" page. */
  readonly providerLabel?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface RedirectPkcePendingOAuth {
  verifier: string;
  agentId: string;
  /** Tenant that owns the agent — the scope the stored credential belongs to. */
  tenantId: string;
  /** Acting user, audit only (tenant_providers.created_by_user_id). */
  createdByUserId: string | null;
  backendUrl: string;
  expiresAt: number;
}

/**
 * Build a base instance. NestJS subclasses pass their own config and the
 * shared `ProviderService` / `ConfigService` / `ModelDiscoveryService`
 * dependencies. The class is plain (not `@Injectable()`) so subclasses
 * stay the DI-registered units; this matches NestJS conventions for
 * shared abstract bases.
 */
export abstract class RedirectPkceOauthBaseService {
  protected readonly logger: Logger;
  /** In-memory pending OAuth flows (not safe behind a load balancer). */
  private readonly pending = new PendingStore<RedirectPkcePendingOAuth>(STATE_TTL_MS);
  private callbackServer: Server | null = null;
  private serverReady: Promise<void> | null = null;
  protected readonly clientId: string;
  protected readonly clientSecret: string | undefined;
  protected readonly redirectUri: string;
  private readonly useCallbackServer: boolean;

  constructor(
    protected readonly providerService: ProviderService,
    configService: ConfigService,
    protected readonly discoveryService: ModelDiscoveryService,
    protected readonly oauthConfig: RedirectPkceOauthConfig,
  ) {
    this.logger = new Logger(oauthConfig.serviceName);
    // `||`, not `??`: docker-compose forwards unset optional vars as an empty
    // string, and `??` would take `''` as a deliberate override — leaving the
    // provider with a blank client id and an OAuth flow that fails at the
    // authorize redirect instead of falling back to the shipped default.
    this.clientId =
      configService.get<string>(oauthConfig.clientIdEnvVar)?.trim() || oauthConfig.defaultClientId;
    this.clientSecret = oauthConfig.clientSecretEnvVar
      ? configService.get<string>(oauthConfig.clientSecretEnvVar)?.trim() ||
        oauthConfig.defaultClientSecret
      : oauthConfig.defaultClientSecret;
    this.redirectUri =
      oauthConfig.redirectUri ?? `http://localhost:${oauthConfig.callbackPort}/auth/callback`;
    // Loopback callback server runs only in development. Production
    // deployments (Docker self-hosted and cloud) complete the OAuth flow
    // through the server's public URL instead.
    this.useCallbackServer =
      (configService.get<string>('app.nodeEnv') ?? 'development') !== 'production';
  }

  async generateAuthorizationUrl(
    agentId: string,
    tenantId: string,
    backendUrl?: string,
    createdByUserId?: string | null,
  ): Promise<string> {
    const state = generateState();
    const { verifier, challenge } = generatePkce();
    // Validate the redirect target now (at storage time) instead of trusting
    // it on the way out. The callback server only ever redirects to
    // localhost-shaped origins, so anything else is dropped here.
    const safeBackendUrl = backendUrl && this.isAllowedRedirectOrigin(backendUrl) ? backendUrl : '';
    this.pending.set(state, {
      verifier,
      agentId,
      tenantId,
      createdByUserId: createdByUserId ?? null,
      backendUrl: safeBackendUrl,
    });
    if (this.useCallbackServer) {
      await this.ensureCallbackServer();
    }
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.oauthConfig.scope,
      state,
      ...(this.oauthConfig.includeNonce ? { nonce: generateState(16) } : {}),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(this.oauthConfig.extraAuthorizeParams ?? {}),
    });
    return `${this.oauthConfig.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(state: string, code: string): Promise<void> {
    const pending = this.pending.peek(state);
    if (!pending) throw new Error('Invalid or expired OAuth state');
    if (pending.expiresAt < Date.now()) {
      this.pending.delete(state);
      throw new Error('OAuth state expired');
    }
    this.pending.delete(state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: pending.verifier,
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await fetch(this.oauthConfig.tokenUrl, {
      method: 'POST',
      headers: this.tokenHeaders(),
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(
        `${this.oauthConfig.providerId} token exchange failed: ${scrubSecrets(text)}`,
      );
      throw new Error('Token exchange failed');
    }
    const data = (await response.json()) as OAuthTokenResponse;
    const baseBlob: OAuthTokenBlob = {
      t: data.access_token,
      r: data.refresh_token ?? '',
      e: Date.now() + data.expires_in * 1000,
    };
    // Subclass hook: providers like Gemini run a per-account onboarding
    // call (CodeAssist `loadCodeAssist`/`onboardUser`) immediately after
    // exchange to discover their assigned project id. The result lives in
    // `blob.u` and is preserved across refreshes by `unwrapToken`.
    const blob = await this.enrichBlob(baseBlob);
    const label = await this.providerService.nextOAuthLabel(
      pending.tenantId,
      this.oauthConfig.providerId,
    );
    const { provider: savedProvider } = await this.providerService.upsertProvider(
      pending.agentId,
      pending.tenantId,
      this.oauthConfig.providerId,
      serializeOAuthTokenBlob(blob),
      'subscription',
      undefined,
      label,
      pending.createdByUserId,
    );
    try {
      await this.discoveryService.discoverModels(savedProvider);
    } catch (err) {
      this.logger.warn(`Model discovery after OAuth failed: ${err}`);
    }
    this.logger.log(
      `${this.oauthConfig.providerId} OAuth token stored for agent=${pending.agentId}`,
    );
    this.shutdownCallbackServerIfIdle();
  }

  async refreshAccessToken(refreshToken: string, resourceField?: string): Promise<OAuthTokenBlob> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await fetch(this.oauthConfig.tokenUrl, {
      method: 'POST',
      headers: this.tokenHeaders(),
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(
        `${this.oauthConfig.providerId} token refresh failed: ${scrubSecrets(text)}`,
      );
      throw new Error('Token refresh failed');
    }
    const data = (await response.json()) as OAuthTokenResponse;
    return {
      t: data.access_token,
      r: data.refresh_token || refreshToken,
      e: Date.now() + data.expires_in * 1000,
      // Preserve provider-specific resource field (e.g. Gemini's CodeAssist
      // project id, MiniMax's resource URL) across refreshes.
      ...(resourceField ? { u: resourceField } : {}),
    };
  }

  /** Parse an OAuth blob and return a valid access token, refreshing if expired. */
  async unwrapToken(
    rawValue: string,
    agentId: string,
    tenantId: string,
    keyLabel?: string,
  ): Promise<string | null> {
    const blob = parseOAuthTokenBlob(rawValue);
    if (!blob) return null;
    // Access token + expiry are required to use the token at all. Refresh
    // token is only required when we need to refresh — providers that omit
    // it (or token responses where we exchanged a code with no offline scope)
    // still produce a usable short-lived access token.
    if (Date.now() < blob.e - 60_000) return blob.t;
    if (!blob.r) return null;
    return this.refreshAndPersistToken(blob, agentId, tenantId, keyLabel);
  }

  private async refreshAndPersistToken(
    blob: OAuthTokenBlob,
    agentId: string,
    tenantId: string,
    keyLabel?: string,
  ): Promise<string | null> {
    const providerId = this.oauthConfig.providerId;
    try {
      const resolved = await coordinateOAuthRefresh<OAuthTokenBlob>({
        key: oauthRefreshKey(providerId, tenantId, keyLabel),
        logger: this.logger,
        callerBlob: blob,
        parse: parseOAuthTokenBlob,
        refresh: (current) => this.refreshAccessToken(current.r, current.u),
        withLock: subscriptionCredentialLock(
          (t, p, l, fn) => this.providerService.withSubscriptionCredentialLock(t, p, l, fn),
          tenantId,
          providerId,
          keyLabel,
          serializeOAuthTokenBlob,
        ),
      });
      return resolved.t;
    } catch (err) {
      this.logger.error(`Failed to refresh ${providerId} token for agent=${agentId}: ${err}`);
      return null;
    }
  }

  /** Revoke an OAuth token at the provider (best-effort; no-op if no revoke URL). */
  async revokeToken(token: string): Promise<void> {
    const revokeUrl = this.oauthConfig.revokeUrl;
    if (!revokeUrl) return;
    try {
      const body = new URLSearchParams({ token, client_id: this.clientId });
      if (this.clientSecret) body.set('client_secret', this.clientSecret);
      const response = await fetch(revokeUrl, {
        method: 'POST',
        headers: this.tokenHeaders(),
        body,
      });
      if (!response.ok) {
        const text = await response.text();
        this.logger.warn(
          `${this.oauthConfig.providerId} token revocation failed: ${scrubSecrets(text)}`,
        );
      } else {
        this.logger.log(`${this.oauthConfig.providerId} OAuth token revoked`);
      }
    } catch (err) {
      this.logger.warn(`${this.oauthConfig.providerId} token revocation error: ${err}`);
    }
  }

  /** Returns the number of pending OAuth states (for testing). */
  getPendingCount(): number {
    return this.pending.size();
  }

  /** Remove a pending OAuth state. */
  clearPendingState(state: string): void {
    this.pending.delete(state);
  }

  /** Path on the loopback callback server (relative). Subclasses can override. */
  protected get callbackPath(): string {
    return this.oauthConfig.callbackPath ?? '/auth/callback';
  }

  /** Headers for token-endpoint requests (exchange, refresh, revoke). */
  private tokenHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(this.oauthConfig.extraTokenHeaders ?? {}),
    };
  }

  /**
   * Optional hook for subclasses to enrich the OAuth blob with provider-
   * specific fields (e.g. Gemini stores the CodeAssist project id in
   * `blob.u` after a successful onboarding round-trip). The default is
   * pass-through. Throwing here aborts the exchange; the user sees a
   * generic "Token exchange failed" error.
   */
  protected async enrichBlob(blob: OAuthTokenBlob): Promise<OAuthTokenBlob> {
    return blob;
  }

  /** Spins up a one-shot HTTP server on `callbackPort` to receive the redirect. */
  private ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return Promise.resolve();
    if (this.serverReady) return this.serverReady;
    this.serverReady = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleCallbackRequest(req, res));
      server.on('error', (err: NodeJS.ErrnoException) => {
        this.callbackServer = null;
        this.serverReady = null;
        if (err.code === 'EADDRINUSE') {
          this.logger.warn(
            `Port ${this.oauthConfig.callbackPort} in use — callback server not started`,
          );
          reject(
            new Error(
              `Port ${this.oauthConfig.callbackPort} is already in use. Run 'lsof -i :${this.oauthConfig.callbackPort}' to find the process.`,
            ),
          );
        } else {
          this.logger.error(`Callback server error: ${err.message}`);
          reject(new Error(`Callback server failed: ${err.message}`));
        }
      });
      server.listen(this.oauthConfig.callbackPort, '127.0.0.1', () => {
        this.logger.log(`OAuth callback server listening on port ${this.oauthConfig.callbackPort}`);
        this.callbackServer = server;
        resolve();
      });
      server.unref();
    });
    return this.serverReady;
  }

  private handleCallbackRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.oauthConfig.callbackPort}`);
    if (url.pathname !== this.callbackPath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const error = url.searchParams.get('error');
    const appUrl = this.pending.peek(state)?.backendUrl || '';
    if (error) {
      const desc = url.searchParams.get('error_description') ?? error;
      this.logger.error(`OAuth callback error from provider: ${desc}`);
      this.pending.delete(state);
      this.shutdownCallbackServerIfIdle();
      this.sendDoneResponse(res, false, appUrl);
      return;
    }
    this.exchangeCode(state, code)
      .then(() => this.sendDoneResponse(res, true, appUrl))
      .catch((err) => {
        this.logger.error(`OAuth callback failed: ${err}`);
        this.shutdownCallbackServerIfIdle();
        this.sendDoneResponse(res, false, appUrl);
      });
  }

  private isAllowedRedirectOrigin(url: string): boolean {
    try {
      // Node's WHATWG URL parser wraps IPv6 hosts in brackets (`[::1]`), so a
      // bare `'::1'` comparison never matches — IPv6 loopback would be dropped
      // at storage and fall back to the inline HTML page. Strip the brackets
      // before comparing so `[::1]` is treated the same as localhost /
      // 127.0.0.1 in both the storage gate and the redirect gate.
      const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  }

  private sendDoneResponse(res: ServerResponse, success: boolean, appUrl: string): void {
    if (appUrl && this.isAllowedRedirectOrigin(appUrl)) {
      const ok = success ? '1' : '0';
      res.writeHead(302, {
        Location: `${appUrl}/api/v1/oauth/${this.oauthConfig.providerId}/done?ok=${ok}`,
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(oauthDoneHtml(success, undefined, this.oauthConfig.providerLabel));
    }
  }

  private shutdownCallbackServerIfIdle(): void {
    if (this.pending.isEmpty() && this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
      this.serverReady = null;
      this.logger.log('OAuth callback server shut down (no pending flows)');
    }
  }
}
