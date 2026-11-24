type SearchParams = Record<string, string | string[] | undefined>;

const UPGRADE_PATH = '/upgrade';
const HOME_PATH = '/';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isSafeInternalRedirect(value: string | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;

  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded.replace(/^\/+/, ''))) return false;
  } catch {
    return false;
  }

  return true;
}

/** Resume the signed MCP authorization request after local or social sign-in. */
export function signedOAuthDestination(rawSearch: string): string | undefined {
  const search = new URLSearchParams(rawSearch);
  if (!search.has('sig') || !search.has('ba_param')) return undefined;
  if (!search.has('client_id') || !search.has('redirect_uri')) return undefined;
  const signedNames = new Set(search.getAll('ba_param'));
  const signed = new URLSearchParams();
  for (const [key, value] of search) {
    if (key === 'sig' || key === 'ba_param' || signedNames.has(key)) signed.append(key, value);
  }
  return `/api/auth/oauth2/authorize?${signed.toString()}`;
}

export function getAuthDestination(searchParams: SearchParams, rawSearch = ''): string {
  const oauthDestination = signedOAuthDestination(rawSearch);
  if (oauthDestination) return oauthDestination;
  const redirect = firstParam(searchParams.redirect);
  if (isSafeInternalRedirect(redirect)) return redirect;
  return firstParam(searchParams.plan) === 'pro' ? UPGRADE_PATH : HOME_PATH;
}

export function buildLoginRedirect(pathname: string, search = ''): string {
  return `/login?redirect=${encodeURIComponent(`${pathname}${search}`)}`;
}

export function appendSearch(pathname: string, search = ''): string {
  if (!search || search === '?') return pathname;
  return `${pathname}${search.startsWith('?') ? search : `?${search}`}`;
}

export function buildSocialAuthUrls(
  searchParams: SearchParams,
  rawSearch = '',
): {
  callbackURL: string;
  errorCallbackURL: string;
} {
  const callbackURL = getAuthDestination(searchParams, rawSearch);
  const errorParams = new URLSearchParams();
  const oauthDestination = signedOAuthDestination(rawSearch);

  if (oauthDestination) {
    const oauthParams = new URLSearchParams(rawSearch);
    oauthParams.set('oauth', 'failed');
    return { callbackURL, errorCallbackURL: `/login?${oauthParams.toString()}` };
  }
  const redirect = firstParam(searchParams.redirect);

  if (isSafeInternalRedirect(redirect)) {
    errorParams.set('redirect', redirect);
  }
  if (firstParam(searchParams.plan) === 'pro') {
    errorParams.set('plan', 'pro');
  }
  // Better Auth appends the actual `error` code to this URL. Keep our fallback
  // marker separate so the callback does not contain two `error` parameters.
  errorParams.set('oauth', 'failed');

  return {
    callbackURL,
    errorCallbackURL: `/login?${errorParams.toString()}`,
  };
}
