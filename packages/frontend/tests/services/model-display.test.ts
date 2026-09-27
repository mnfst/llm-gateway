import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetModelPrices = vi.fn();
vi.mock("../../src/services/api.js", () => ({
  getModelPrices: () => mockGetModelPrices(),
}));

vi.mock("../../src/services/provider-utils.js", () => ({
  getModelLabel: (_providerId: string, model: string) => `label:${model}`,
}));

vi.mock("../../src/services/routing-utils.js", () => ({
  inferProviderFromModel: (m: string) => {
    if (m.startsWith("gpt-")) return "openai";
    if (m.startsWith("claude-")) return "anthropic";
    if (m.startsWith("custom:")) return "custom";
    return undefined;
  },
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ""),
}));

describe("model-display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns display name from cache after preload", async () => {
    mockGetModelPrices.mockResolvedValue({
      models: [
        { model_name: "gpt-4o", provider: "OpenAI", display_name: "GPT-4o" },
      ],
    });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    // Wait for the async preload
    await vi.waitFor(() => {
      expect(mockGetModelPrices).toHaveBeenCalled();
    });
    // Give time for async loading to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(getModelDisplayName("gpt-4o")).toBe("GPT-4o");
  });

  it("falls back to getModelLabel when model not in cache", async () => {
    mockGetModelPrices.mockResolvedValue({ models: [] });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    // gpt-4o has inferred provider "openai", so getModelLabel is used
    expect(getModelDisplayName("gpt-4o")).toBe("label:gpt-4o");
  });

  it("falls back to stripCustomPrefix for unknown models", async () => {
    mockGetModelPrices.mockResolvedValue({ models: [] });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    // No inferred provider for "unknown-model" → returns slug as-is
    expect(getModelDisplayName("unknown-model")).toBe("unknown-model");
  });

  it("handles getModelPrices failure gracefully", async () => {
    mockGetModelPrices.mockRejectedValue(new Error("API error"));

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    // Should not throw, falls back to getModelLabel
    expect(getModelDisplayName("gpt-4o")).toBe("label:gpt-4o");
  });

  it("strips custom prefix for custom models", async () => {
    mockGetModelPrices.mockResolvedValue({ models: [] });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    // custom provider → inferProviderFromModel returns "custom" → getModelLabel
    expect(getModelDisplayName("custom:abc/my-model")).toBe(
      "label:custom:abc/my-model"
    );
  });

  it("returns slug before cache is loaded", async () => {
    mockGetModelPrices.mockReturnValue(new Promise(() => {})); // never resolves

    const { getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    // Cache not loaded yet, falls back to getModelLabel or slug
    expect(getModelDisplayName("gpt-4o")).toBe("label:gpt-4o");
  });
});

describe("model-display — gateway ids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("resolves a gateway id through the bare model in the pricing catalogue", async () => {
    mockGetModelPrices.mockResolvedValue({
      models: [
        {
          model_name: "deepseek-flash",
          provider: "DeepSeek",
          display_name: "DeepSeek V4.1 Flash",
        },
      ],
    });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    expect(getModelDisplayName("opencode-go/deepseek-flash")).toBe(
      "DeepSeek V4.1 Flash",
    );
  });

  it("falls through when neither the gateway id nor the bare model is known", async () => {
    mockGetModelPrices.mockResolvedValue({ models: [] });

    const { preloadModelDisplayNames, getModelDisplayName } = await import(
      "../../src/services/model-display.js"
    );

    preloadModelDisplayNames();
    await new Promise((r) => setTimeout(r, 10));

    expect(getModelDisplayName("opencode-go/unknown-model")).toBe(
      "opencode-go/unknown-model",
    );
  });
});
