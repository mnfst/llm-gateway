/**
 * Test double for ProviderService.withSubscriptionCredentialLock.
 * Bridges to the older getFreshSubscriptionCredential / upsertProvider mocks
 * so existing unwrapToken assertions keep working.
 */
export function mockSubscriptionCredentialLock(provider: {
  getFreshSubscriptionCredential: jest.Mock;
  upsertProvider: jest.Mock;
}): jest.Mock {
  return jest.fn(
    async (
      tenantId: string,
      providerId: string,
      label: string | undefined,
      fn: (ops: {
        readFreshRaw: () => Promise<string | null>;
        writeRaw: (raw: string) => Promise<void>;
      }) => Promise<unknown>,
    ) =>
      fn({
        readFreshRaw: () => provider.getFreshSubscriptionCredential(tenantId, providerId, label),
        writeRaw: async (raw: string) => {
          // agentId is unused for locked in-place writes in production; null
          // keeps the upsert shape tests already assert on.
          await provider.upsertProvider(
            null,
            tenantId,
            providerId,
            raw,
            'subscription',
            undefined,
            label,
          );
        },
      }),
  );
}
