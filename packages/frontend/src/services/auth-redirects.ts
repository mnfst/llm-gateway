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

export function getAuthDestination(searchParams: SearchParams): string {
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

export function buildSocialAuthUrls(searchParams: SearchParams): {
  callbackURL: string;
  errorCallbackURL: string;
} {
  const callbackURL = getAuthDestination(searchParams);
  const errorParams = new URLSearchParams();
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
