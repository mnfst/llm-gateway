import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

vi.stubGlobal("navigator", {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import ClaudeCodeSetup from "../../src/components/ClaudeCodeSetup";

describe("ClaudeCodeSetup", () => {
  const baseProps = {
    apiKey: null as string | null,
    keyPrefix: null as string | null,
    baseUrl: "http://localhost:3001/v1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the settings.json instruction with highlighted path and command", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    const codes = container.querySelectorAll(".setup-model-hint__code");
    const labels = Array.from(codes).map((c) => c.textContent);
    expect(labels).toContain("~/.claude/settings.json");
    expect(labels).toContain("claude");
    expect(labels).toContain("auto");
  });

  it("explains how to get a 1M context window through the gateway", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    const text = container.textContent ?? "";
    expect(text).toContain("assumes a 200k context window");
    expect(text).toContain("/model claude-opus-5-5[1m]");
  });

  it("renders the JSON settings block with Manifest auto model and ANTHROPIC vars", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    const text = container.textContent ?? "";
    expect(text).toContain('"model": "auto"');
    expect(text).toContain('"env"');
    expect(text).toContain("ANTHROPIC_BASE_URL");
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("strips trailing /v1 from the base URL inside the rendered JSON", () => {
    // Anthropic SDK auto-appends /v1/messages, so base_url must not end in /v1.
    const { container } = render(() => (
      <ClaudeCodeSetup {...baseProps} baseUrl="http://localhost:3001/v1" />
    ));
    expect(container.textContent).toContain("http://localhost:3001");
    expect(container.textContent).not.toContain("http://localhost:3001/v1");
  });

  it("masks the API key when only a prefix is available", () => {
    const { container } = render(() => (
      <ClaudeCodeSetup {...baseProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.textContent).toContain("mnfst_abc...");
    // No reveal/hide button when there's no full key to reveal.
    expect(container.querySelector('[aria-label="Reveal API key"]')).toBeNull();
    expect(container.querySelector('[aria-label="Hide API key"]')).toBeNull();
  });

  it("uses 'mnfst_YOUR_KEY' placeholder when neither full key nor prefix is set", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    expect(container.textContent).toContain("mnfst_YOUR_KEY");
  });

  it("toggles the API key reveal when the eye button is clicked", () => {
    const { container } = render(() => (
      <ClaudeCodeSetup {...baseProps} apiKey="mnfst_full_secret_value" keyPrefix="mnfst_full" />
    ));
    // Masked by default.
    expect(container.textContent).toContain("mnfst_full...");
    expect(container.textContent).not.toContain("mnfst_full_secret_value");

    const reveal = container.querySelector('[aria-label="Reveal API key"]') as HTMLButtonElement;
    expect(reveal).not.toBeNull();
    fireEvent.click(reveal);
    expect(container.textContent).toContain("mnfst_full_secret_value");

    const hide = container.querySelector('[aria-label="Hide API key"]') as HTMLButtonElement;
    expect(hide).not.toBeNull();
    fireEvent.click(hide);
    expect(container.textContent).not.toContain("mnfst_full_secret_value");
  });

  it("copy button always uses the real key (not the masked one)", () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    const { container } = render(() => (
      <ClaudeCodeSetup {...baseProps} apiKey="mnfst_full_secret_value" keyPrefix="mnfst_full" />
    ));
    const copyBtn = container.querySelector(".modal-terminal__copy + *, .copy-btn") as
      | HTMLElement
      | null;
    // The CopyButton component's click handler uses the prop text — find it by class then click.
    const copyButton = container.querySelector('button[aria-label*="Copy" i]') as HTMLButtonElement
      | null;
    expect(copyButton).not.toBeNull();
    fireEvent.click(copyButton!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("mnfst_full_secret_value");
    expect(writeText.mock.calls[0][0]).toContain('"model": "auto"');
    void copyBtn;
  });

  it("renders inside a setup-agents-card so card styling applies", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    expect(container.querySelector(".setup-agents-card")).not.toBeNull();
  });

  it("uses a JSON code block (not bash, not yaml)", () => {
    const { container } = render(() => <ClaudeCodeSetup {...baseProps} />);
    const codeEl = container.querySelector(".hljs.language-json");
    expect(codeEl).not.toBeNull();
  });
});
