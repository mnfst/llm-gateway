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
    personal: ["openclaw", "hermes", "other"],
    automation: ["n8n", "other"],
    app: ["openai-sdk", "vercel-ai-sdk", "langchain", "other"],
    coding: ["claude-code", "opencode", "codex", "other"],
  },
  PLATFORM_ICONS: {
    openclaw: "/icons/openclaw.png",
    hermes: "/icons/hermes.png",
    n8n: "/icons/n8n.svg",
    "openai-sdk": "/icons/providers/openai.svg",
    "vercel-ai-sdk": "/icons/vercel.svg",
    langchain: "/icons/langchain.svg",
    "claude-code": "/icons/providers/claude-code.svg",
    opencode: "/icons/providers/opencode.svg",
    codex: "/icons/providers/codex.svg",
  },
}));

import AgentTypeSelect from "../../src/components/AgentTypeSelect";

describe("AgentTypeSelect", () => {
  const defaultProps = {
    category: "personal" as string | null,
    platform: "openclaw" as string | null,
    onCategoryChange: vi.fn(),
    onPlatformChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders trigger button with caret", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const trigger = container.querySelector(".agent-type-select__trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.querySelector(".agent-type-select__caret")).not.toBeNull();
  });

  it("shows selected platform icon in trigger", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("src")).toBe("/icons/openclaw.png");
  });

  it("does not show dropdown by default", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    expect(container.querySelector(".agent-type-select__dropdown")).toBeNull();
  });

  it("opens dropdown on trigger click", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    expect(container.querySelector(".agent-type-select__dropdown")).not.toBeNull();
  });

  it("shows all four category group labels in dropdown order (personal → automation → app → coding)", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const labels = container.querySelectorAll(".agent-type-select__group-label");
    expect(labels).toHaveLength(4);
    expect(labels[0].textContent).toContain("AI agent");
    expect(labels[1].textContent).toContain("Automation");
    expect(labels[2].textContent).toContain("App AI SDK");
    expect(labels[3].textContent).toContain("Coding Assistant");
  });

  it("shows all platforms from all four categories in dropdown", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // personal: 3, automation: 2, app: 4, coding: 4 = 13
    expect(options).toHaveLength(13);
  });

  it("shows platform names in options", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const dropdown = container.querySelector(".agent-type-select__dropdown")!;
    expect(dropdown.textContent).toContain("OpenClaw");
    expect(dropdown.textContent).toContain("Hermes Agent");
    expect(dropdown.textContent).toContain("n8n");
    expect(dropdown.textContent).toContain("OpenAI SDK");
    expect(dropdown.textContent).toContain("Vercel AI SDK");
    expect(dropdown.textContent).toContain("LangChain");
    expect(dropdown.textContent).toContain("Claude Code");
    expect(dropdown.textContent).toContain("OpenCode");
    expect(dropdown.textContent).toContain("Codex");
  });

  it("places Claude Code in the coding column with the official Claude mark", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // Coding column is rightmost: index 9 = claude-code, index 10 = opencode, index 11 = codex.
    expect(options[9].textContent).toContain("Claude Code");
    const claudeIcon = options[9].querySelector(".agent-type-select__option-icon");
    expect(claudeIcon!.getAttribute("src")).toBe("/icons/providers/claude-code.svg");
  });

  it("places OpenCode in the coding column with the OpenCode mark", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    expect(options[10].textContent).toContain("OpenCode");
    const opencodeIcon = options[10].querySelector(".agent-type-select__option-icon");
    expect(opencodeIcon!.getAttribute("src")).toBe("/icons/providers/opencode.svg");
  });

  it("places Codex in the coding column with the Codex mark", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    expect(options[11].textContent).toContain("Codex");
    const codexIcon = options[11].querySelector(".agent-type-select__option-icon");
    expect(codexIcon!.getAttribute("src")).toBe("/icons/providers/codex.svg");
  });

  it("places n8n in the automation column with the n8n mark", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    expect(options[3].textContent).toContain("n8n");
    const n8nIcon = options[3].querySelector(".agent-type-select__option-icon");
    expect(n8nIcon!.getAttribute("src")).toBe("/icons/n8n.svg");
  });

  it("shows platform icons in options", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const icons = container.querySelectorAll(".agent-type-select__option-icon");
    expect(icons.length).toBeGreaterThanOrEqual(5);
    expect(icons[0].getAttribute("src")).toBe("/icons/openclaw.png");
    expect(icons[1].getAttribute("src")).toBe("/icons/hermes.png");
  });

  it("marks selected option", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const selected = container.querySelectorAll(".agent-type-select__option--selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("OpenClaw");
  });

  it("calls onCategoryChange and onPlatformChange on option click", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeSelect
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // Click "Hermes Agent" (index 1, personal category)
    fireEvent.click(options[1]);
    expect(onCategoryChange).toHaveBeenCalledWith("personal");
    expect(onPlatformChange).toHaveBeenCalledWith("hermes");
  });

  it("calls with automation category when n8n selected", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeSelect
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[3]); // n8n
    expect(onCategoryChange).toHaveBeenCalledWith("automation");
    expect(onPlatformChange).toHaveBeenCalledWith("n8n");
  });

  it("calls with app category when app platform selected", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeSelect
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // Click "OpenAI SDK" (index 5, app category: after personal[3] + automation[2])
    fireEvent.click(options[5]);
    expect(onCategoryChange).toHaveBeenCalledWith("app");
    expect(onPlatformChange).toHaveBeenCalledWith("openai-sdk");
  });

  it("calls with coding category when Claude Code selected", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeSelect
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // Click "Claude Code" (index 9, coding category: after personal[3] + automation[2] + app[4])
    fireEvent.click(options[9]);
    expect(onCategoryChange).toHaveBeenCalledWith("coding");
    expect(onPlatformChange).toHaveBeenCalledWith("claude-code");
  });

  it("calls with coding category when coding/Other selected", () => {
    const onCategoryChange = vi.fn();
    const onPlatformChange = vi.fn();
    const { container } = render(() => (
      <AgentTypeSelect
        {...defaultProps}
        onCategoryChange={onCategoryChange}
        onPlatformChange={onPlatformChange}
      />
    ));
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[12]); // coding Other
    expect(onCategoryChange).toHaveBeenCalledWith("coding");
    expect(onPlatformChange).toHaveBeenCalledWith("other");
  });

  it("closes dropdown after selection", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    expect(container.querySelector(".agent-type-select__dropdown")).not.toBeNull();
    const options = container.querySelectorAll(".agent-type-select__option");
    fireEvent.click(options[0]);
    expect(container.querySelector(".agent-type-select__dropdown")).toBeNull();
  });

  it("closes dropdown on Escape key", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    expect(container.querySelector(".agent-type-select__dropdown")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".agent-type-select__dropdown")).toBeNull();
  });

  it("closes dropdown on click outside", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    expect(container.querySelector(".agent-type-select__dropdown")).not.toBeNull();
    fireEvent.click(document.body);
    expect(container.querySelector(".agent-type-select__dropdown")).toBeNull();
  });

  it("disables trigger when disabled prop is true", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} disabled={true} />
    ));
    const trigger = container.querySelector(".agent-type-select__trigger") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it("shows other-agent.svg for personal other", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} category="personal" platform="other" />
    ));
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other-agent.svg");
  });

  it("shows other.svg for app other", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} category="app" platform="other" />
    ));
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("shows other.svg for automation other", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} category="automation" platform="other" />
    ));
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("shows other.svg for coding other (not the personal-agent variant)", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} category="coding" platform="other" />
    ));
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("shows Other in all four groups", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    // personal other at index 2, automation other at index 4, app other at index 8, coding other at index 12
    expect(options[2].textContent).toContain("Other");
    expect(options[4].textContent).toContain("Other");
    expect(options[8].textContent).toContain("Other");
    expect(options[12].textContent).toContain("Other");
  });

  it("uses the personal-agent icon only for personal/Other (automation + app + coding share other.svg)", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll(".agent-type-select__option");
    const personalOther = options[2].querySelector(".agent-type-select__option-icon");
    const automationOther = options[4].querySelector(".agent-type-select__option-icon");
    const appOther = options[8].querySelector(".agent-type-select__option-icon");
    const codingOther = options[12].querySelector(".agent-type-select__option-icon");
    expect(personalOther!.getAttribute("src")).toBe("/icons/other-agent.svg");
    expect(automationOther!.getAttribute("src")).toBe("/icons/other.svg");
    expect(appOther!.getAttribute("src")).toBe("/icons/other.svg");
    expect(codingOther!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("sets aria-expanded on trigger", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const trigger = container.querySelector(".agent-type-select__trigger")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("sets aria-haspopup on trigger", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const trigger = container.querySelector(".agent-type-select__trigger")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  });

  it("sets role listbox on dropdown", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const dropdown = container.querySelector(".agent-type-select__dropdown");
    expect(dropdown!.getAttribute("role")).toBe("listbox");
  });

  it("sets role option on each platform option", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(13);
  });

  it("sets aria-selected on selected option", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    fireEvent.click(container.querySelector(".agent-type-select__trigger")!);
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("toggles dropdown on repeated trigger clicks", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const trigger = container.querySelector(".agent-type-select__trigger")!;
    fireEvent.click(trigger);
    expect(container.querySelector(".agent-type-select__dropdown")).not.toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector(".agent-type-select__dropdown")).toBeNull();
  });

  it("applies open class to trigger when dropdown is open", () => {
    const { container } = render(() => <AgentTypeSelect {...defaultProps} />);
    const trigger = container.querySelector(".agent-type-select__trigger")!;
    expect(trigger.classList.contains("agent-type-select__trigger--open")).toBe(false);
    fireEvent.click(trigger);
    expect(trigger.classList.contains("agent-type-select__trigger--open")).toBe(true);
  });

  it("shows fallback icon when no category/platform selected", () => {
    const { container } = render(() => (
      <AgentTypeSelect {...defaultProps} category={null} platform={null} />
    ));
    const icon = container.querySelector(".agent-type-select__trigger-icon");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("src")).toBe("/icons/other.svg");
  });

  it("aria-label says 'Select' when no platform is selected, otherwise the platform label", () => {
    const { container: blankContainer } = render(() => (
      <AgentTypeSelect {...defaultProps} category={null} platform={null} />
    ));
    expect(
      blankContainer.querySelector(".agent-type-select__trigger")!.getAttribute("aria-label"),
    ).toBe("Harness type: Select");

    const { container: pickedContainer } = render(() => (
      <AgentTypeSelect {...defaultProps} category="coding" platform="claude-code" />
    ));
    expect(
      pickedContainer.querySelector(".agent-type-select__trigger")!.getAttribute("aria-label"),
    ).toBe("Harness type: Claude Code");
  });
});
