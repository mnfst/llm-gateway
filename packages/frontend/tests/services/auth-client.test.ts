import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy that `createAuthClient` from `better-auth/solid` resolves to. The
// module under test (`auth-client.ts`) imports this symbol and invokes it
// once at module-load time, so we mock it before any dynamic import below.
// Use `vi.hoisted` so the spy is available to the hoisted `vi.mock` factory.
const { createAuthClientMock, stripeClientMock } = vi.hoisted(() => ({
  createAuthClientMock: vi.fn((config: unknown) => ({
    __mockClient: true,
    config,
  })),
  // `stripeClient` is a factory the module passes into `plugins`. We tag the
  // return value so the test can assert the plugin was actually wired in.
  stripeClientMock: vi.fn((opts: unknown) => ({ __stripePlugin: true, opts })),
}));

vi.mock("better-auth/solid", () => ({
  createAuthClient: createAuthClientMock,
}));

vi.mock("@better-auth/stripe/client", () => ({
  stripeClient: stripeClientMock,
}));

describe("authClient", () => {
  beforeEach(() => {
    // Each test re-imports the module to re-trigger the top-level
    // `createAuthClient({...})` call against a fresh mock state.
    vi.resetModules();
    createAuthClientMock.mockClear();
    stripeClientMock.mockClear();

    // Pin `window.location.origin` to a deterministic value. jsdom would
    // otherwise return "http://localhost:3000", which is fine but we want
    // tests to be insensitive to harness defaults.
    vi.stubGlobal("window", {
      ...window,
      location: {
        ...window.location,
        origin: "https://app.manifest.build",
      },
    } as Window & typeof globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates client with correct baseURL from window.location.origin", async () => {
    await import("../../src/services/auth-client.js");

    expect(createAuthClientMock).toHaveBeenCalledTimes(1);
    const config = createAuthClientMock.mock.calls[0][0] as {
      baseURL: string;
      basePath: string;
    };
    expect(config.baseURL).toBe("https://app.manifest.build");
  });

  it("creates client with basePath /api/auth", async () => {
    await import("../../src/services/auth-client.js");

    expect(createAuthClientMock).toHaveBeenCalledTimes(1);
    const config = createAuthClientMock.mock.calls[0][0] as {
      baseURL: string;
      basePath: string;
    };
    expect(config.basePath).toBe("/api/auth");
  });

  it("registers the stripe subscription client plugin", async () => {
    await import("../../src/services/auth-client.js");

    // `stripeClient` must be called once with subscription mode enabled...
    expect(stripeClientMock).toHaveBeenCalledTimes(1);
    expect(stripeClientMock.mock.calls[0][0]).toEqual({ subscription: true });

    // ...and the returned plugin must be passed into `createAuthClient`'s
    // `plugins` array, which is what widens the client type with the
    // `subscription` namespace in production.
    const config = createAuthClientMock.mock.calls[0][0] as {
      plugins: unknown[];
    };
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]).toBe(stripeClientMock.mock.results[0].value);
  });

  it("exports authClient as createAuthClient return type", async () => {
    const mod = await import("../../src/services/auth-client.js");

    // The exported `authClient` must be the exact value returned by
    // `createAuthClient`. We return a tagged object from the mock so we
    // can assert identity, not just shape.
    expect(mod.authClient).toBeDefined();
    expect((mod.authClient as unknown as { __mockClient: boolean }).__mockClient).toBe(true);
    expect(mod.authClient).toBe(createAuthClientMock.mock.results[0].value);
  });

  it("initialization does not throw errors", async () => {
    // The module evaluates its top-level `createAuthClient({...})` call
    // synchronously on import. A throw inside `createAuthClient` would
    // surface here as a rejected promise from the dynamic import.
    await expect(import("../../src/services/auth-client.js")).resolves.toBeDefined();
  });

  it("re-reads window.location.origin on each module load", async () => {
    // First load uses the stubbed origin from beforeEach.
    await import("../../src/services/auth-client.js");
    expect(createAuthClientMock.mock.calls[0][0]).toMatchObject({
      baseURL: "https://app.manifest.build",
    });

    // Swap the origin and reload. We expect a fresh `createAuthClient`
    // call with the new origin, proving the module is not cached against
    // a stale value baked at first import.
    vi.resetModules();
    createAuthClientMock.mockClear();
    stripeClientMock.mockClear();
    vi.stubGlobal("window", {
      ...window,
      location: {
        ...window.location,
        origin: "http://localhost:3001",
      },
    } as Window & typeof globalThis);

    await import("../../src/services/auth-client.js");
    expect(createAuthClientMock).toHaveBeenCalledTimes(1);
    expect(createAuthClientMock.mock.calls[0][0]).toMatchObject({
      baseURL: "http://localhost:3001",
      basePath: "/api/auth",
    });
  });
});
