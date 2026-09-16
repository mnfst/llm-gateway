---
'manifest': patch
---

Resolve the Better Auth `baseURL` per request when the dashboard and the API answer on more than one host. The OAuth `redirect_uri` and the session cookie are pinned to `baseURL`, so with a single static origin a sign-in started on `app.manifest.build` returned to `gateway.manifest.build` and set the cookie there — an origin the dashboard cannot read, which stranded the user. Allowed hosts are derived from `BETTER_AUTH_URL`, `CORS_ORIGIN`, and the optional `BETTER_AUTH_ALLOWED_HOSTS`; unknown hosts fall back to the canonical `BETTER_AUTH_URL`, and development keeps the static origin.
