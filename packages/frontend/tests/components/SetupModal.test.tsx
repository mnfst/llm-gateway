import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

// SolidJS createResource leaks rejected promises as unhandled rejections
// when error gate is bypassed (e.g. props.apiKey provided)
const noop = () => {};
beforeAll(() => process.on("unhandledRejection", noop));
afterAll(() => process.off("unhandledRejection", noop));

vi.mock("../../src/services/api.js", () => ({
  getAgentKey: vi.fn().mockResolvedValue({ keyPrefix: "mnfst_abc" }),
}));

vi.mock("../../src/components/SetupStepAddProvider.jsx", () => ({
  default: (props: any) => (
    <div data-testid="step-add-provider" data-base-url={props.baseUrl ?? ""} data-key={props.apiKey ?? ""} data-prefix={props.keyPrefix ?? ""}>
      Add Provider Step
    </div>
  ),
}));

vi.mock("../../src/components/ErrorState.jsx", () => ({
  default: (props: any) => (
    <div data-testid="error-state" data-error={String(props.error ?? "")}>
      {props.title}
      <button data-testid="retry-btn" onClick={() => props.onRetry?.()}>Retry</button>
    </div>
  ),
}));

import SetupModal from "../../src/components/SetupModal";

describe("SetupModal", () => {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onGoToRouting = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(() => (
      <SetupModal open={false} agentName="test-agent" onClose={onClose} />
    ));
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("renders modal title with agent name when open", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="my-agent" onClose={onClose} />
    ));
    expect(container.textContent).toContain("Set up harness:");
    expect(container.textContent).toContain("my-agent");
  });

  it("shows close button with aria-label", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    expect(container.querySelector('[aria-label="Close"]')).not.toBeNull();
  });

  it("closes when close button clicked", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    fireEvent.click(container.querySelector('[aria-label="Close"]')!);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows Add Provider step", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    expect(container.querySelector('[data-testid="step-add-provider"]')).not.toBeNull();
  });

  it("shows Done button", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    expect(container.textContent).toContain("Done");
  });

  it("navigates to routing when Done is clicked", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} onDone={onDone} onGoToRouting={onGoToRouting} />
    ));
    fireEvent.click(container.querySelector(".setup-modal__next")!);
    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onGoToRouting).toHaveBeenCalled();
  });

  it("handles Done when callbacks are omitted", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    expect(() => fireEvent.click(container.querySelector(".setup-modal__next")!)).not.toThrow();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows description text", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    expect(container.textContent).toContain("Connect your harness to Manifest");
  });

  it("closes on overlay click", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    fireEvent.click(container.querySelector(".modal-overlay")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when Escape key is pressed on the overlay", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    fireEvent.keyDown(container.querySelector(".modal-overlay")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("passes apiKey prop to Add Provider step", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" apiKey="mnfst_full_key" onClose={onClose} />
    ));
    const step = container.querySelector('[data-testid="step-add-provider"]');
    expect(step).not.toBeNull();
    expect(step!.getAttribute("data-key")).toBe("mnfst_full_key");
  });

  it("uses the app baseUrl on gateway.manifest.build", () => {
    const origLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { ...origLocation, hostname: "gateway.manifest.build", origin: "https://gateway.manifest.build" },
      writable: true,
      configurable: true,
    });
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    const step = container.querySelector('[data-testid="step-add-provider"]');
    expect(step?.getAttribute("data-base-url")).toBe("https://app.manifest.build/v1");
    Object.defineProperty(window, "location", { value: origLocation, writable: true, configurable: true });
  });

  it("has role dialog and aria-modal", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
  });

  it("has aria-labelledby pointing to title", () => {
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog!.getAttribute("aria-labelledby")).toBe("setup-modal-title");
    expect(container.querySelector("#setup-modal-title")).not.toBeNull();
  });

  it("shows error state when API key fetch fails", async () => {
    const { getAgentKey } = await import("../../src/services/api.js");
    (getAgentKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Fetch failed"));
    const { container } = render(() => (
      <SetupModal open={true} agentName="fail-agent" onClose={onClose} />
    ));
    await vi.waitFor(() => {
      const errorEl = container.querySelector('[data-testid="error-state"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toContain("Could not load API key");
    });
  });

  it("still shows setup content when apiKey prop is provided even if fetch returns null", async () => {
    const { getAgentKey } = await import("../../src/services/api.js");
    (getAgentKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { container } = render(() => (
      <SetupModal open={true} agentName="fail-agent" apiKey="mnfst_provided" onClose={onClose} />
    ));
    await vi.waitFor(() => {
      const step = container.querySelector('[data-testid="step-add-provider"]');
      expect(step).not.toBeNull();
      expect(step!.getAttribute("data-key")).toBe("mnfst_provided");
    });
  });

  it("falls back to apiKeyData apiKey when props.apiKey is not provided", async () => {
    const { getAgentKey } = await import("../../src/services/api.js");
    (getAgentKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      keyPrefix: "mnfst_abc",
      apiKey: "mnfst_fetched_key",
    });
    const { container } = render(() => (
      <SetupModal open={true} agentName="test-agent" onClose={onClose} />
    ));
    await vi.waitFor(() => {
      const step = container.querySelector('[data-testid="step-add-provider"]');
      expect(step).not.toBeNull();
      expect(step!.getAttribute("data-key")).toBe("mnfst_fetched_key");
    });
  });
});
