import { useSearchParams } from '@solidjs/router';
import { Title } from '@solidjs/meta';
import { Show, createEffect, createSignal, type Component } from 'solid-js';

interface ClientSummary {
  client_id: string;
  client_name?: string;
  client_uri?: string;
}

const SCOPE_COPY: Record<string, string> = {
  'mcp:read': 'Read your harnesses, providers, routing, models, and request ledger',
  'mcp:write': 'Create, change, and delete harnesses, providers, and routing',
  offline_access: 'Stay connected by refreshing access after the short-lived token expires',
};

/**
 * The OAuth consent screen for the remote MCP server.
 *
 * Better Auth's MCP plugin sends an authenticated user here with the standard
 * authorization query. The explicit click is a security boundary — a drive-by
 * link must never silently grant an MCP client access to a workspace.
 */
const Consent: Component = () => {
  const [params] = useSearchParams();
  const [client, setClient] = createSignal<ClientSummary | null>(null);
  const [loadError, setLoadError] = createSignal('');
  const [busy, setBusy] = createSignal<'approve' | 'deny' | null>(null);
  const [submitError, setSubmitError] = createSignal('');

  const clientId = () => String(params.client_id ?? '');
  const scopes = () =>
    String(params.scope ?? '')
      .split(' ')
      .map((s) => s.trim())
      .filter(Boolean);

  /**
   * Keep only the OAuth parameters covered by Better Auth's signed query. The
   * server verifies `sig`; forwarding unsigned extras would fail that check.
   */
  const signedOAuthQuery = (): string | undefined => {
    const search = new URLSearchParams(window.location.search);
    if (!search.has('sig')) return undefined;
    const signedNames = search.getAll('ba_param');
    if (signedNames.length === 0) return undefined;
    const allowed = new Set(signedNames);
    const signed = new URLSearchParams();
    for (const [key, value] of search) {
      if (key === 'sig' || key === 'ba_param' || allowed.has(key)) signed.append(key, value);
    }
    return signed.toString();
  };

  createEffect(() => {
    if (!clientId()) {
      setLoadError('This authorization request has no client identifier.');
      return;
    }
    void fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId())}`, {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? (r.json() as Promise<ClientSummary>) : Promise.reject()))
      .then(setClient)
      .catch(() => setLoadError('Could not load the requesting client.'));
  });

  const decide = async (accept: boolean): Promise<void> => {
    const oauthQuery = signedOAuthQuery();
    if (!oauthQuery) {
      setSubmitError('This authorization request has an invalid signature.');
      return;
    }
    setBusy(accept ? 'approve' : 'deny');
    setSubmitError('');
    try {
      const response = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: string;
        error?: string;
        error_description?: string;
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          body?.message || body?.error_description || body?.error || 'Authorization request failed',
        );
      }
      if (typeof body?.url === 'string') {
        window.location.assign(body.url);
      } else {
        setSubmitError('The authorization server returned no redirect.');
        setBusy(null);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  };

  return (
    <div class="auth-layout">
      <Title>Authorize MCP client - Manifest</Title>
      <div class="auth-card" style="text-align: center;">
        <div class="auth-logo">
          <img
            src="/logotype-white.svg"
            alt="Manifest LLM Gateway"
            class="auth-logo__img auth-logo__img--light"
          />
          <img src="/logotype-dark.svg" alt="" class="auth-logo__img auth-logo__img--dark" />
        </div>
        <Show
          when={!loadError()}
          fallback={
            <div class="auth-header">
              <h1 class="auth-header__title">Invalid authorization request</h1>
              <p class="auth-header__subtitle">{loadError()}</p>
            </div>
          }
        >
          <div class="auth-header">
            <h1 class="auth-header__title">Authorize this MCP client?</h1>
            <p class="auth-header__subtitle">
              <strong>{client()?.client_name || clientId()}</strong> wants to connect to your
              Manifest workspace.
            </p>
            <Show when={client()?.client_uri}>
              <p class="auth-header__subtitle">{client()?.client_uri}</p>
            </Show>
          </div>
          <ul style="text-align: left; margin: 0 auto 1rem; max-width: 320px;">
            {scopes().map((scope) => (
              <li>{SCOPE_COPY[scope] ?? scope}</li>
            ))}
          </ul>
          <Show when={submitError()}>
            <div class="auth-form__error" role="alert">
              {submitError()}
            </div>
          </Show>
          <div class="auth-form" style="display: flex; gap: 0.75rem;">
            <button
              class="auth-form__submit"
              type="button"
              disabled={busy() !== null}
              onClick={() => void decide(true)}
            >
              {busy() === 'approve' ? 'Allowing…' : 'Allow access'}
            </button>
            <button
              class="auth-form__submit auth-form__submit--secondary"
              type="button"
              disabled={busy() !== null}
              onClick={() => void decide(false)}
            >
              {busy() === 'deny' ? 'Denying…' : 'Deny'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Consent;
