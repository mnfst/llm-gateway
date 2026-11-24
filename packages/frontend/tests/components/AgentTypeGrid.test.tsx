import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

vi.mock("manifest-shared", () => ({
  AGENT_CATEGORIES: ["personal", "automation", "app", "coding"],
  CATEGORY_LABELS: {
    personal: "AI agent",
    automation: "Automation",
    app: "App AI SDK",
    coding: "Coding Assistant",
  },
  PLATFORM_LABELS: {
    openclaw: "OpenClaw",
    hermes: "Hermes Agent",
    nanobot: "Nanobot",
    craft: "Craft Agent",
    n8n: "n8n",
    "openai-sdk": "OpenAI SDK",
    "vercel-ai-sdk": "Vercel AI SDK",
    langchain: "LangChain",
    curl: "cURL",
    "claude-code": "Claude Code",
    opencode: "OpenCode",
    codex: "Codex",
    other: "Other",
  },
  PLATFORMS_BY_CATEGORY: {
    personal: ["openclaw", "hermes", "nanobot", "craft", "other"],
    automation: ["n8n", "other"],
    app: ["openai-sdk", "vercel-ai-sdk", "langchain", "other"],
    coding: ["claude-code", "opencode", "codex", "other"],
  },
  PLATFORM_ICONS: {
    openclaw: "/icons/openclaw.png",
    hermes: "/icons/hermes.png",
    nanobot: "/icons/nanobot.png",
    craft: "/icons/craft.png",
    n8n: "/icons/n8n.svg",
    "openai-sdk": "/icons/providers/openai.svg",
    "vercel-ai-sdk": "/icons/vercel.svg",
    langchain: "/icons/langchain.svg",
    "claude-code": "/icons/providers/claude-code.svg",
    opencode: "/icons/providers/opencode.svg",
    codex: "/icons/providers/codex.svg",
  },
}));

import AgentTypeGrid from "../../src/components/AgentTypeGrid";

describe("AgentTypeGrid", () => {
  const defaultProps = {
    category: "personal" as string | null,
    platform: "openclaw" as string | null,
    onCategoryChange: vi.fn(),
    onPlatformChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders inline grid with all four category groups in order", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const labels = container.querySelectorAll(".agent-type-select__group-label");
    expect(labels).toHaveLength(4);
    expect(labels[0].textContent).toContain("AI agent");
    expect(labels[1].textContent).toContain("Automation");
    expect(labels[2].textContent).toContain("App AI SDK");
    expect(labels[3].textContent).toContain("Coding Assistant");
  });

  it("renders all platform options from all four categories", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    expect(options).toHaveLength(15);
  });

  it("renders four columns", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const columns = container.querySelectorAll(".agent-type-select__column");
    expect(columns).toHaveLength(4);
  });

  it("marks selected option", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const selected = container.querySelectorAll(".agent-type-select__option--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("OpenClaw");
  });

  it("calls onCategoryChange and onPlatformChange on click", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[7]); // OpenAI SDK (app category)
    expect(onCategoryChange).toHaveBeenCalledWith("app");
    expect(onPlatformChange).toHaveBeenCalledWith("openai-sdk");
  });

  it("selecting n8n routes to automation/n8n", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[5]); // n8n (automation column, first item)
    expect(onCategoryChange).toHaveBeenCalledWith("automation");
    expect(onPlatformChange).toHaveBeenCalledWith("n8n");
  });

  it("selecting Claude Code routes to coding/claude-code", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[11]); // Claude Code (coding column, first item)
    expect(onCategoryChange).toHaveBeenCalledWith("coding");
    expect(onPlatformChange).toHaveBeenCalledWith("claude-code");
  });

  it("selecting OpenCode routes to coding/opencode", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[12]); // OpenCode (coding column, second item)
    expect(onCategoryChange).toHaveBeenCalledWith("coding");
    expect(onPlatformChange).toHaveBeenCalledWith("opencode");
  });

  it("selecting Codex routes to coding/codex", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[13]);
    expect(onCategoryChange).toHaveBeenCalledWith("coding");
    expect(onPlatformChange).toHaveBeenCalledWith("codex");
  });

  it("shows platform icons", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const icons = container.querySelectorAll(".agent-type-select__option-icon");
    expect(icons.length).toBeGreaterThanOrEqual(5);
    expect(icons[0].getAttribute("src")).toBe("/icons/openclaw.png");
  });

  it("uses other-agent.svg for personal Other", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    const icon = options[4].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other-agent.svg");
  });

  it("uses other.svg for app Other", () => {
    const { container } = render(() => (
      <AgentTypeGrid {...defaultProps} category="app" platform="other" />
    ));
    const selected = container.querySelector(".agent-type-select__option--selected");
    const icon = selected?.querySelector(".agent-type-select__option-icon");
    expect(selected?.textContent).toContain("Other");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("uses other.svg for automation Other", () => {
    const { container } = render(() => (
      <AgentTypeGrid {...defaultProps} category="automation" platform="other" />
    ));
    const selected = container.querySelector(".agent-type-select__option--selected");
    const icon = selected?.querySelector(".agent-type-select__option-icon");
    expect(selected?.textContent).toContain("Other");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("uses other.svg for coding Other (not the personal-agent variant)", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    // coding/Other is at index 14 (5 personal + 2 automation + 4 app + 3 coding before it)
    const icon = options[14].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("renders the n8n icon in the automation column", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    const icon = options[5].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/n8n.svg");
  });

  it("renders the official Claude Code icon in the coding column", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    const icon = options[11].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/providers/claude-code.svg");
  });

  it("renders the OpenCode icon in the coding column", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    const icon = options[12].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/providers/opencode.svg");
  });

  it("renders the Codex icon in the coding column", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll(".agent-type-select__option");
    const icon = options[13].querySelector(".agent-type-select__option-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/providers/codex.svg");
  });

  it("disables buttons when disabled prop is true", () => {
    const { container } = render(() => (
      <AgentTypeGrid {...defaultProps} disabled={true} />
    ));
    const options = container.querySelectorAll(".agent-type-select__option") as NodeListOf<HTMLButtonElement>;
    for (const opt of options) {
      expect(opt.disabled).toBe(true);
    }
  });

  it("has inline modifier class", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    expect(container.querySelector(".agent-type-select__dropdown--inline")).not.toBeNull();
  });

  it("sets aria-selected on selected option", () => {
    const { container } = render(() => <AgentTypeGrid {...defaultProps} />);
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("selects app Other correctly", () => {
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        category="app"
        platform="other"
      />
    ));
    const selected = container.querySelectorAll(".agent-type-select__option--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Other");
  });

  it("selects coding Claude Code correctly", () => {
    const { container } = render(() => (
      <AgentTypeGrid
        {...defaultProps}
        category="coding"
        platform="claude-code"
      />
    ));
    const selected = container.querySelectorAll(".agent-type-select__option--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Claude Code");
  });
});
