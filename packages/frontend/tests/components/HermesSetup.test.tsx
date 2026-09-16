import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

vi.stubGlobal("navigator", {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import HermesSetup from "../../src/components/HermesSetup";

describe("HermesSetup", () => {
  const defaultProps = {
    apiKey: null as string | null,
    keyPrefix: null as string | null,
    baseUrl: "http://localhost:3001/v1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders description text", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("Point Hermes at the Manifest endpoint to route requests across multiple models");
  });

  it("renders CLI and Hermes onboard tabs", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    expect(segment).not.toBeNull();
    const btns = segment!.querySelectorAll(".setup-segment__btn");
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe("Configuration file");
    expect(btns[1].textContent).toBe("Hermes onboard");
  });

  it("defaults to Configuration file tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    const btns = segment!.querySelectorAll(".setup-segment__btn");
    expect(btns[0].classList.contains("setup-segment__btn--active")).toBe(true);
    expect(btns[1].classList.contains("setup-segment__btn--active")).toBe(false);
  });

  it("shows hermes config edit command on CLI tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("hermes config edit");
  });

  it("shows CLI hint text on CLI tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("Open the Hermes configuration file");
  });

  it("shows config.yaml code block with model section only", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("http://localhost:3001/v1");
    expect(container.textContent).toContain("model:");
    expect(container.textContent).toContain("provider: custom");
    expect(container.textContent).toContain("default: auto");
    expect(container.textContent).not.toContain("custom_providers:");
  });

  it("shows onboard fields on CLI tab with YAML key names", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const fields = container.querySelectorAll(".setup-onboard-fields__row");
    expect(fields.length).toBeGreaterThanOrEqual(4);
    expect(fields[0].textContent).toContain("provider");
    expect(fields[0].textContent).toContain("custom");
    expect(fields[1].textContent).toContain("base_url");
    expect(fields[1].textContent).toContain("http://localhost:3001/v1");
    expect(fields[2].textContent).toContain("api_key");
    expect(fields[3].textContent).toContain("default");
    expect(fields[3].textContent).toContain("auto");
  });

  it("shows masked key placeholder when no apiKey or keyPrefix", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("mnfst_YOUR_KEY");
  });

  it("shows key prefix when keyPrefix provided", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.textContent).toContain("mnfst_abc...");
  });

  it("does not show eye toggle when no apiKey", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).toBeNull();
  });

  it("shows eye toggle on CLI tab when apiKey provided", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_full_key" keyPrefix="mnfst_ful" />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).not.toBeNull();
  });

  it("reveals key in CLI when eye toggle clicked", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_full_key" keyPrefix="mnfst_ful" />
    ));
    expect(container.textContent).not.toContain("mnfst_full_key");
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_full_key");
  });

  it("hides key again on second CLI eye toggle click", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_full_key" keyPrefix="mnfst_ful" />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_full_key");
    fireEvent.click(container.querySelector('[aria-label="Hide API key"]')!);
    expect(container.textContent).not.toContain("mnfst_full_key");
  });

  it("shows CLI copy button", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_full_key" keyPrefix="mnfst_ful" />
    ));
    const cliBlock = container.querySelector(".setup-cli-block");
    const copyBtn = cliBlock!.querySelector('[aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
  });

  it("copies yaml config when copy button in code block is clicked", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_test_key" keyPrefix="mnfst_te" />
    ));
    const codeBlock = container.querySelector(".setup-cli-block");
    const copyBtn = codeBlock?.querySelector('[aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
    fireEvent.click(copyBtn!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("provider: custom")
    );
  });

  it("uses custom base URL in code block and fields", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} baseUrl="https://example.com/v1" />
    ));
    expect(container.textContent).toContain("https://example.com/v1");
  });

  it("renders the config.yaml section heading", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).toContain("config.yaml");
  });

  it("renders EyeIcon with closed state by default", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_test" keyPrefix="mnfst_t" />
    ));
    const eyeBtn = container.querySelector('[aria-label="Reveal API key"]');
    expect(eyeBtn).not.toBeNull();
    const svg = eyeBtn!.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("renders EyeIcon with open state when key revealed", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_test" keyPrefix="mnfst_t" />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    const eyeBtn = container.querySelector('[aria-label="Hide API key"]');
    expect(eyeBtn).not.toBeNull();
    const svg = eyeBtn!.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("shows masked key in code block when no apiKey", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} keyPrefix="mnfst_pre" />
    ));
    expect(container.textContent).toContain("mnfst_pre...");
  });

  // --- Hermes onboard (wizard) tab tests ---

  it("switches to Hermes onboard tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    const btns = segment!.querySelectorAll(".setup-segment__btn");
    fireEvent.click(btns[1]);
    expect(btns[1].classList.contains("setup-segment__btn--active")).toBe(true);
    expect(container.textContent).toContain("hermes model");
    expect(container.textContent).toContain("Custom endpoint");
  });

  it("shows wizard hint text on Hermes onboard tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    expect(container.textContent).toContain("Custom endpoint");
  });

  it("shows onboard fields on wizard tab with Hermes field names", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    const fieldsList = container.querySelector('[aria-label="Configuration values"]');
    const fields = fieldsList!.querySelectorAll(".setup-onboard-fields__row");
    expect(fields).toHaveLength(3);
    expect(fields[0].textContent).toContain("API base URL");
    expect(fields[0].textContent).toContain("http://localhost:3001/v1");
    expect(fields[1].textContent).toContain("API Key");
    expect(fields[2].textContent).toContain("Model name");
    expect(fields[2].textContent).toContain("auto");
  });

  it("does not show Provider row on wizard tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    const fieldsList = container.querySelector('[aria-label="Configuration values"]');
    const fields = fieldsList!.querySelectorAll(".setup-onboard-fields__row");
    const labels = Array.from(fields).map((f) => f.querySelector(".setup-onboard-fields__label")?.textContent);
    expect(labels).not.toContain("Provider");
  });

  it("shows eye toggle on wizard API Key field when apiKey provided", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_wiz" keyPrefix="mnfst_wi" />
    ));
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    const eyeBtns = container.querySelectorAll('[aria-label="Reveal API key"]');
    expect(eyeBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("reveals API key in wizard field when eye toggle clicked", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_wiz_full" keyPrefix="mnfst_wi" />
    ));
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    expect(container.textContent).not.toContain("mnfst_wiz_full");
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_wiz_full");
  });

  it("shows wizard copy button when key is hidden", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_wiz" keyPrefix="mnfst_wi" />
    ));
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    const copyBtns = container.querySelectorAll('[aria-label="Copy to clipboard"]');
    expect(copyBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("switches back from wizard to CLI tab", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    const btns = segment!.querySelectorAll(".setup-segment__btn");
    fireEvent.click(btns[1]); // wizard
    fireEvent.click(btns[0]); // back to CLI
    expect(btns[0].classList.contains("setup-segment__btn--active")).toBe(true);
    expect(container.textContent).toContain("Open the Hermes configuration file");
  });

  it("has correct aria attributes on tabs", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector('[role="tablist"]');
    expect(segment).not.toBeNull();
    const btns = segment!.querySelectorAll('[role="tab"]');
    expect(btns).toHaveLength(2);
    expect(btns[0].getAttribute("aria-selected")).toBe("true");
    expect(btns[1].getAttribute("aria-selected")).toBe("false");
  });

  it("hides CLI content when wizard tab is active", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    expect(container.textContent).not.toContain("hermes config edit");
    expect(container.textContent).not.toContain("config.yaml");
  });

  it("hides wizard content when CLI tab is active", () => {
    const { container } = render(() => <HermesSetup {...defaultProps} />);
    expect(container.textContent).not.toContain("Run the onboarding wizard");
  });

  it("copies CLI snippet with full key to clipboard when revealed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_clip_key" keyPrefix="mnfst_cli" />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    const cliBlock = container.querySelector(".setup-cli-block");
    const copyBtn = cliBlock!.querySelector('[aria-label="Copy to clipboard"]');
    fireEvent.click(copyBtn!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      const copiedText = writeText.mock.calls[0][0] as string;
      expect(copiedText).toContain("mnfst_clip_key");
      expect(copiedText).toContain("provider: custom");
    });
  });

  it("wizard tab uses custom base URL", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} baseUrl="https://app.manifest.build/v1" />
    ));
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    expect(container.textContent).toContain("https://app.manifest.build/v1");
  });

  it("wizard and CLI tabs have independent key reveal state", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_independent" keyPrefix="mnfst_in" />
    ));
    // Reveal key on CLI tab
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_independent");
    // Switch to wizard tab -- key should be masked there
    const segment = container.querySelector(".setup-segment--full");
    fireEvent.click(segment!.querySelectorAll(".setup-segment__btn")[1]);
    const fieldsList = container.querySelector('[aria-label="Configuration values"]');
    const fields = fieldsList!.querySelectorAll(".setup-onboard-fields__row");
    const apiKeyField = Array.from(fields).find((f) =>
      f.textContent?.includes("API Key")
    );
    expect(apiKeyField?.textContent).toContain("mnfst_in...");
    expect(apiKeyField?.textContent).not.toContain("mnfst_independent");
  });

  it("CLI tab api_key field has eye toggle and copy button", () => {
    const { container } = render(() => (
      <HermesSetup {...defaultProps} apiKey="mnfst_cli_field" keyPrefix="mnfst_cl" />
    ));
    const fields = container.querySelectorAll(".setup-onboard-fields__row");
    const apiKeyField = Array.from(fields).find((f) =>
      f.querySelector(".setup-onboard-fields__label")?.textContent === "api_key"
    );
    expect(apiKeyField).not.toBeNull();
    expect(apiKeyField!.querySelector('[aria-label="Reveal API key"]')).not.toBeNull();
    expect(apiKeyField!.querySelector('[aria-label="Copy to clipboard"]')).not.toBeNull();
  });
});
