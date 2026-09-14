---
'manifest': minor
---

Treat upstream 401s on subscription credentials as an auth failure instead of a transient error. When OpenAI (or another OAuth provider) rejects a token, the gateway already forces one token refresh and retries; if that still fails it now marks the connection unhealthy, skips it in routing, and goes straight to the fallback chain without another upstream round-trip. The provider list reports `requires_reauth` per connection so the dead credential is visible in the dashboard and can be reconnected. `ProxyFallbackService` logs now name the `keyLabel`, HTTP status, and a short upstream error for every failed attempt, so a fan-out across accounts is diagnosable.
