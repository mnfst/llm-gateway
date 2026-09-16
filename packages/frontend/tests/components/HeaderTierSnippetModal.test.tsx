import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

const mockGetAgentKey = vi.fn();
vi.mock("../../src/services/api.js", () => ({
  getAgentKey: (...args: unknown[]) => mockGetAgentKey(...args),
}));

vi.mock("../../src/components/FrameworkSnippets.jsx", () => ({
  default: (props: {
    customHeaders?: Record<string, string>;
    baseUrl: string;
    apiKey?: string | null;
    keyPrefix?: string | null;
  }) => (
    <div data-testid="framework-snippets">
      <div data-testid="snippets-base-url">{props.baseUrl}</div>
      <div data-testid="snippets-custom-headers">
        {JSON.stringify(props.customHeaders ?? null)}
      </div>
      <div data-testid="snippets-api-key">{props.apiKey ?? "null"}</div>
      <div data-testid="snippets-key-prefix">{props.keyPrefix ?? "null"}</div>
    </div>
  ),
}));

import HeaderTierSnippetModal from "../../src/components/HeaderTierSnippetModal";
import type { HeaderTier } from "../../src/services/api/header-tiers";

const baseTier: HeaderTier = {
  id: "ht-1",
  agent_id: "agent-1",
  name: "Premium",
  header_key: "x-manifest-tier",
  header_value: "premium",
  badge_color: "indigo",
  sort_order: 0,
  enabled: true,
  override_route: { provider: "openai", authType: "api_key", model: "gpt-4o" },
  fallback_routes: null,
  created_at: "2025-01-01",
  updated_at: "2025-01-01",
};

describe("HeaderTierSnippetModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentKey.mockResolvedValue({ apiKey: "mnfst_abc", keyPrefix: "mnfst_abc" });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { hostname: "localhost", origin: "http://localhost:3001" },
    });
  });

  it("renders the tier name in the modal title", () => {
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    const title = container.querySelector("#header-tier-snippet-title");
    expect(title?.textContent).toContain("Premium");
  });

  it("renders the override_route.model in the description", () => {
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    const code = container.querySelector(".modal-card__desc code");
    expect(code?.textContent).toBe("gpt-4o");
  });

  it("falls back to placeholder text when override_route is null", () => {
    const tier = { ...baseTier, override_route: null };
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={tier} onClose={vi.fn()} />
    ));
    const code = container.querySelector(".modal-card__desc code");
    expect(code?.textContent).toContain("no model assigned");
  });

  it("passes the tier's header_key/header_value as customHeaders to FrameworkSnippets", () => {
    const { getByTestId } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    const headers = JSON.parse(getByTestId("snippets-custom-headers").textContent ?? "{}") as Record<
      string,
      string
    >;
    expect(headers).toEqual({ "x-manifest-tier": "premium" });
  });

  it("uses window.location.origin + /v1 as the base URL on non-gateway.manifest.build hosts", () => {
    const { getByTestId } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    expect(getByTestId("snippets-base-url").textContent).toBe("http://localhost:3001/v1");
  });

  it("uses the app URL on gateway.manifest.build", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { hostname: "gateway.manifest.build", origin: "https://gateway.manifest.build" },
    });
    const { getByTestId } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    expect(getByTestId("snippets-base-url").textContent).toBe("https://app.manifest.build/v1");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const closeBtn = container.querySelector(".modal__close") as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the Done button is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const doneBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Done",
    ) as HTMLButtonElement;
    fireEvent.click(doneBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the overlay is clicked but not the modal card", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    // simulate click on the overlay itself (target === currentTarget)
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the modal card", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const card = container.querySelector(".modal-card") as HTMLElement;
    fireEvent.click(card);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key press", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose for non-Escape keys", () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={onClose} />
    ));
    const overlay = container.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("threads apiKey and keyPrefix from getAgentKey through to FrameworkSnippets", async () => {
    const { findByTestId } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    expect((await findByTestId("snippets-api-key")).textContent).toBe("mnfst_abc");
    expect((await findByTestId("snippets-key-prefix")).textContent).toBe("mnfst_abc");
  });

  it("threads null apiKey when getAgentKey resolves with no keys", async () => {
    mockGetAgentKey.mockResolvedValue({ apiKey: null, keyPrefix: null });
    const { findByTestId } = render(() => (
      <HeaderTierSnippetModal agentName="demo" tier={baseTier} onClose={vi.fn()} />
    ));
    expect((await findByTestId("snippets-api-key")).textContent).toBe("null");
    expect((await findByTestId("snippets-key-prefix")).textContent).toBe("null");
  });
});
