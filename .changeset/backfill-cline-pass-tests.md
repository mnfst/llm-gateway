---
'manifest': patch
---

Backfill subscription test coverage for the ClinePass provider that was missed in the original `feat: add cline-pass subscription provider` PR (#2412):

- Add `cline-pass` to the `contains all supported subscription provider IDs` list.
- Add `getSubscriptionProviderConfig` test asserting the `cline-pass` config shape (`subscriptionLabel`, `subscriptionAuthMode`, `subscriptionKeyPlaceholder`, `knownModelsMatch: 'exact'`, and `subscriptionCapabilities`).
- Replace the smoke `toContain` test in `getSubscriptionKnownModels` with an exact `toEqual` of the curated model list, matching the `moonshot`/`xai`/`xiaomi` test pattern.
- Add `getSubscriptionKnownModelsMatch` test asserting `cline-pass` resolves to `'exact'`.
- Add `getSubscriptionCapabilities` test asserting the `200_000` max context window and the `supportsPromptCaching: false` / `supportsBatching: false` flags.

No production behavior changes; tests only.
