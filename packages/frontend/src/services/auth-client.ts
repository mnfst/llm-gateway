import { createAuthClient } from 'better-auth/solid';
import { stripeClient } from '@better-auth/stripe/client';

// The stripe client plugin widens the client with a `subscription` namespace
// (upgrade/cancel/billingPortal/list) that the billing UI calls.
//
// The explicit annotation is required because `declaration: true` demands a
// portable type: the *inferred* type reaches into private dist chunks of
// `@better-auth/stripe` and `better-auth` that TS cannot name (TS2742).
// Spelling the same type via instantiation expressions on the two imported
// factories keeps it portable while `authClient.subscription` stays fully
// typed. Keep the annotation's plugin options in sync with the call below.
export const authClient: ReturnType<
  typeof createAuthClient<{
    plugins: [ReturnType<typeof stripeClient<{ subscription: true }>>];
  }>
> = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [stripeClient({ subscription: true })],
});
