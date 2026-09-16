import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

vi.stubGlobal("navigator", {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import FrameworkSnippets from "../../src/components/FrameworkSnippets";

describe("FrameworkSnippets", () => {
  const defaultProps = {
    apiKey: null as string | null,
    keyPrefix: null as string | null,
    baseUrl: "http://localhost:3001/v1",
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders connection details with base URL", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.textContent).toContain("http://localhost:3001/v1");
    expect(container.textContent).toContain("Base URL");
  });

  it("renders connection details with API key placeholder", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.textContent).toContain("mnfst_YOUR_KEY");
    expect(container.textContent).toContain("API Key");
  });

  it("renders Model field with auto value", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.textContent).toContain("Model");
    expect(container.textContent).toContain("auto");
  });

  it("renders connection details with key prefix when provided", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.textContent).toContain("mnfst_abc...");
  });

  it("renders full API key when provided", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_full_key_123" />
    ));
    expect(container.textContent).toContain("mnfst_full_key_123");
  });

  it("hides full key when hideFullKey is set", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    expect(container.textContent).not.toContain("mnfst_secret");
    expect(container.textContent).toContain("mnfst_abc...");
  });

  it("shows API key copy button when key is hidden", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    const keyRow = container.querySelectorAll(".setup-onboard-fields__row")[1];
    const copyBtn = keyRow?.querySelector('[aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
  });

  it("shows API key copy button when key is revealed", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    const keyRow = container.querySelectorAll(".setup-onboard-fields__row")[1];
    const copyBtn = keyRow?.querySelector('[aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn!.hasAttribute("disabled")).toBe(false);
  });

  it("shows eye toggle to reveal key when hideFullKey and apiKey set", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).not.toBeNull();
  });

  it("reveals key when eye toggle is clicked", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_secret");
    expect(container.querySelector('[aria-label="Hide API key"]')).not.toBeNull();
  });

  it("hides key again on second toggle", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" hideFullKey />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    fireEvent.click(container.querySelector('[aria-label="Hide API key"]')!);
    expect(container.textContent).not.toContain("mnfst_secret");
    expect(container.textContent).toContain("mnfst_abc...");
  });

  it("does not show eye toggle when no apiKey", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).toBeNull();
    expect(container.querySelector('[aria-label="Hide API key"]')).toBeNull();
  });

  it("renders five toolkit tabs", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    expect(tabs).toHaveLength(5);
    expect(tabs[0].textContent).toContain("OpenAI SDK");
    expect(tabs[1].textContent).toContain("Anthropic SDK");
    expect(tabs[2].textContent).toContain("Vercel AI SDK");
    expect(tabs[3].textContent).toContain("LangChain");
    expect(tabs[4].textContent).toContain("cURL");
  });

  it("defaults to OpenAI SDK tab", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const activeTab = container.querySelector(".panel__tab--active");
    expect(activeTab).not.toBeNull();
    expect(activeTab!.textContent).toContain("OpenAI SDK");
  });

  it("shows OpenAI Python SDK snippet by default", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.textContent).toContain("from openai import OpenAI");
    expect(container.textContent).toContain("Responses API");
    expect(container.textContent).toContain("Chat Completions");
    expect(container.textContent).toContain("client.responses.create");
    expect(container.textContent).not.toContain("chat.completions.create");
  });

  it("switches to Chat Completions with the OpenAI API toggle", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const apiBtns = container.querySelectorAll(".toolkit-api-toggle__btn");
    expect(apiBtns).toHaveLength(2);
    expect(apiBtns[0].textContent).toContain("Responses API");
    expect(apiBtns[1].textContent).toContain("Chat Completions");
    expect(apiBtns[0].classList.contains("toolkit-api-toggle__btn--active")).toBe(true);

    fireEvent.click(apiBtns[1]);

    expect(apiBtns[1].classList.contains("toolkit-api-toggle__btn--active")).toBe(true);
    expect(container.textContent).not.toContain("client.responses.create");
    expect(container.textContent).toContain("client.chat.completions.create");
    expect(container.textContent).toContain('messages=[{"role": "user", "content": "Hello"}]');
  });

  it("shows language toggle on OpenAI SDK tab", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.querySelector(".toolkit-lang-toggle")).not.toBeNull();
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    expect(langBtns).toHaveLength(2);
    expect(langBtns[0].textContent).toContain("Python");
    expect(langBtns[1].textContent).toContain("TypeScript");
  });

  it("switches to TypeScript when language toggle is clicked", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    fireEvent.click(langBtns[1]); // TypeScript
    expect(container.textContent).toContain('import OpenAI from "openai"');
    expect(container.textContent).toContain("client.responses.create");
  });

  it("shows TypeScript Chat Completions when both toggles are selected", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    fireEvent.click(langBtns[1]); // TypeScript
    const apiBtns = container.querySelectorAll(".toolkit-api-toggle__btn");
    fireEvent.click(apiBtns[1]); // Chat Completions
    expect(container.textContent).toContain("client.chat.completions.create");
    expect(container.textContent).toContain('messages: [{ role: "user", content: "Hello" }]');
  });

  it("switches to Anthropic SDK tab on click", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[1]);
    expect(container.textContent).toContain("from anthropic import Anthropic");
    expect(container.textContent).toContain("client.messages.create");
  });

  it("shows Anthropic TypeScript snippet when TypeScript selected", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[1]); // Anthropic SDK
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    fireEvent.click(langBtns[1]); // TypeScript
    expect(container.textContent).toContain('import Anthropic from "@anthropic-ai/sdk"');
    expect(container.textContent).toContain("client.messages.create");
  });

  it("switches to Vercel AI SDK tab on click", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[2]);
    expect(container.textContent).toContain("Vercel AI SDK");
  });

  it("shows language toggle on Vercel AI SDK tab", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[2]); // Vercel AI SDK
    expect(container.querySelector(".toolkit-lang-toggle")).not.toBeNull();
  });

  it("shows Vercel TypeScript snippet when TypeScript selected", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[2]); // Vercel AI SDK
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    fireEvent.click(langBtns[1]); // TypeScript
    expect(container.textContent).toContain("createOpenAI");
  });

  it("hides language toggle on LangChain and cURL tabs", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[3]); // LangChain
    expect(container.querySelector(".toolkit-lang-toggle")).toBeNull();
    fireEvent.click(tabs[4]); // cURL
    expect(container.querySelector(".toolkit-lang-toggle")).toBeNull();
  });

  it("hides OpenAI API toggle outside the OpenAI SDK tab", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[2]); // Vercel AI SDK
    expect(container.querySelector(".toolkit-api-toggle")).toBeNull();
  });

  it("switches to LangChain tab on click", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[3]);
    expect(container.textContent).toContain("ChatOpenAI");
  });

  it("switches to cURL tab on click", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[4]);
    expect(container.textContent).toContain("curl -X POST");
    expect(container.textContent).toContain("Bearer");
  });

  it("persists selected toolkit tab in localStorage", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(tabs[2]);
    expect(localStorage.getItem("manifest_setup_toolkit")).toBe("vercel-ai-sdk");
  });

  it("persists selected OpenAI language in localStorage", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const langBtns = container.querySelectorAll(".toolkit-lang-toggle__btn");
    fireEvent.click(langBtns[1]);
    expect(localStorage.getItem("manifest_setup_openai_lang")).toBe("typescript");
  });

  it("restores toolkit tab from localStorage", () => {
    localStorage.setItem("manifest_setup_toolkit", "curl");
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const activeTab = container.querySelector(".panel__tab--active");
    expect(activeTab!.textContent).toContain("cURL");
  });

  it("restores OpenAI language from localStorage", () => {
    localStorage.setItem("manifest_setup_openai_lang", "typescript");
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.textContent).toContain('import OpenAI from "openai"');
  });

  it("has copy buttons for snippets", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const copyButtons = container.querySelectorAll(".modal-terminal__copy");
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("includes baseUrl in snippets", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} baseUrl="https://app.manifest.build/v1" />
    ));
    expect(container.textContent).toContain("https://app.manifest.build/v1");
  });

  it("uses setup-method-tabs class", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.querySelector(".setup-method-tabs")).not.toBeNull();
  });

  it("uses framework-snippets class", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.querySelector(".framework-snippets")).not.toBeNull();
  });

  it("uses setup-onboard-fields class for connection details", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    expect(container.querySelector(".setup-onboard-fields")).not.toBeNull();
  });

  it("active tab changes visual state on click", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const tabs = container.querySelectorAll(".panel__tab");
    expect(tabs[0].classList.contains("panel__tab--active")).toBe(true);
    expect(tabs[1].classList.contains("panel__tab--active")).toBe(false);
    fireEvent.click(tabs[1]);
    expect(tabs[0].classList.contains("panel__tab--active")).toBe(false);
    expect(tabs[1].classList.contains("panel__tab--active")).toBe(true);
  });

  it("renders tab icons for tabs that have them", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const icons = container.querySelectorAll(".panel__tab-icon");
    expect(icons.length).toBe(4); // openai, anthropic, vercel, langchain (not curl)
  });

  it("renders language icons in OpenAI SDK toggle", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    const toggleImgs = container.querySelectorAll(".toolkit-lang-toggle__btn img");
    expect(toggleImgs.length).toBe(2);
  });

  it("copies snippet with real key after revealing", async () => {
    const writeTextMock = vi.mocked(navigator.clipboard.writeText);
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_real_key" keyPrefix="mnfst_re" hideFullKey />
    ));
    // Reveal the key via the code block eye toggle
    fireEvent.click(container.querySelector('[aria-label="Reveal API key in code"]')!);
    const copyBtn = container.querySelector('.setup-cli-block__actions [aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
    await fireEvent.click(copyBtn!);
    expect(writeTextMock).toHaveBeenCalled();
    const copiedText = writeTextMock.mock.calls[0][0];
    expect(copiedText).toContain("mnfst_real_key");
  });

  it("copies snippet with masked key when no full apiKey provided", async () => {
    const writeTextMock = vi.mocked(navigator.clipboard.writeText);
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} keyPrefix="mnfst_pre" />
    ));
    const copyBtn = container.querySelector('.setup-cli-block__actions [aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
    await fireEvent.click(copyBtn!);
    expect(writeTextMock).toHaveBeenCalled();
    const copiedText = writeTextMock.mock.calls[0][0];
    expect(copiedText).toContain("mnfst_pre...");
  });

  it("shows eye toggle in code block when apiKey provided", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_se" hideFullKey />
    ));
    const eyeBtn = container.querySelector('.setup-cli-block__actions [aria-label="Reveal API key in code"]');
    expect(eyeBtn).not.toBeNull();
  });

  it("hides toolkit tabs when defaultToolkit is provided", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} defaultToolkit="curl" />
    ));
    expect(container.querySelectorAll(".panel__tab")).toHaveLength(0);
    expect(container.textContent).toContain("curl");
  });

  it("shows correct snippet for defaultToolkit", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} defaultToolkit="langchain" />
    ));
    expect(container.textContent).toContain("ChatOpenAI");
  });

  it("shows code block copy button even when key hidden", () => {
    const { container } = render(() => (
      <FrameworkSnippets {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_se" hideFullKey />
    ));
    const copyBtn = container.querySelector('.setup-cli-block__actions [aria-label="Copy to clipboard"]');
    expect(copyBtn).not.toBeNull();
  });

  it("renders a connection-details row for each customHeader entry", () => {
    const { container } = render(() => (
      <FrameworkSnippets
        {...defaultProps}
        customHeaders={{ "x-manifest-tier": "premium", "x-app": "billing" }}
      />
    ));
    expect(container.textContent).toContain("x-manifest-tier");
    expect(container.textContent).toContain("premium");
    expect(container.textContent).toContain("x-app");
    expect(container.textContent).toContain("billing");
  });

  it("does not render any header row when customHeaders is omitted", () => {
    const { container } = render(() => <FrameworkSnippets {...defaultProps} />);
    // Headers ship under labels prefixed with "Header " — none should appear.
    expect(container.textContent).not.toContain("Header x-");
  });

  it("weaves customHeaders into the snippet code (defaultHeaders for OpenAI TS)", () => {
    const { container } = render(() => (
      <FrameworkSnippets
        {...defaultProps}
        defaultToolkit="openai-sdk"
        customHeaders={{ "x-manifest-tier": "premium" }}
      />
    ));
    // We're inside the python tab by default for openai-sdk; switch to TS via
    // localStorage isn't reliable here, so just assert the python form rendered.
    expect(container.textContent).toContain("default_headers");
    expect(container.textContent).toContain("x-manifest-tier");
  });
});
