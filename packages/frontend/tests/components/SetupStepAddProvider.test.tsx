import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

vi.stubGlobal("navigator", {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import SetupStepAddProvider from "../../src/components/SetupStepAddProvider";

describe("SetupStepAddProvider", () => {
  const defaultProps = {
    apiKey: null as string | null,
    keyPrefix: null as string | null,
    baseUrl: "http://localhost:3001/v1",
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it("renders heading", () => {
    render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(screen.getByText("Connect your harness to Manifest")).toBeDefined();
  });

  it("shows description with auto model", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.textContent).toContain("auto");
    expect(container.textContent).toContain("Point your harness");
  });

  it("renders Agents and Toolkits segmented tabs", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const segment = container.querySelector(".setup-segment");
    expect(segment).not.toBeNull();
    const buttons = segment!.querySelectorAll(".setup-segment__btn");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe("Agents");
    expect(buttons[1].textContent).toBe("Toolkits");
  });

  it("defaults to Agents tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const activeBtn = container.querySelector(".setup-segment__btn--active");
    expect(activeBtn).not.toBeNull();
    expect(activeBtn!.textContent).toBe("Agents");
  });

  it("shows OpenClaw, Hermes, Nanobot, Craft, Claude Code, OpenCode, and Codex tabs inside Agents", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    expect(agentTabs).toHaveLength(7);
    expect(agentTabs[0].textContent).toContain("OpenClaw");
    expect(agentTabs[1].textContent).toContain("Hermes Agent");
    expect(agentTabs[2].textContent).toContain("Nanobot");
    expect(agentTabs[3].textContent).toContain("Craft Agent");
    expect(agentTabs[4].textContent).toContain("Claude Code");
    expect(agentTabs[5].textContent).toContain("OpenCode");
    expect(agentTabs[6].textContent).toContain("Codex");
  });

  it("shows Nanobot setup when Nanobot tab clicked", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[2]); // Nanobot
    expect(container.textContent).toContain("~/.nanobot/config.json");
    expect(container.textContent).toContain("apiBase");
  });

  it("shows Claude Code setup when Claude Code tab clicked", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[4]); // Claude Code
    expect(container.textContent).toContain("ANTHROPIC_BASE_URL");
    expect(container.textContent).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("shows Craft setup when Craft Agent tab clicked", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[3]); // Craft Agent
    expect(container.textContent).toContain("Manifest provider preset");
    expect(container.textContent).toContain("mnfst_YOUR_KEY");
  });

  it("shows OpenCode setup when OpenCode tab clicked", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[5]); // OpenCode
    expect(container.textContent).toContain("~/.config/opencode/opencode.json");
    expect(container.textContent).toContain('"model": "manifest/auto"');
  });

  it("shows Codex setup when Codex tab clicked", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[6]);
    expect(container.textContent).toContain("~/.codex/config.toml");
    expect(container.textContent).toContain('wire_api = "responses"');
    expect(container.textContent).toContain('model_provider = "manifest"');
  });

  it("defaults to OpenClaw agent tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    expect(agentTabs[0].classList.contains("panel__tab--active")).toBe(true);
  });

  it("shows OpenClaw logo in agent tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const icon = container.querySelector(".panel__tab-icon");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("src")).toBe("/icons/openclaw.svg");
  });

  it("shows Agents card when OpenClaw selected", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.querySelector(".setup-agents-card")).not.toBeNull();
    expect(container.textContent).toContain("manifest/auto");
  });

  it("shows Hermes setup when Hermes Agent selected", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[1]); // Hermes Agent
    expect(container.textContent).toContain("Point Hermes at the Manifest endpoint");
  });

  it("switches back to OpenClaw from Hermes Agent", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const agentTabs = container.querySelectorAll(".panel__tab");
    fireEvent.click(agentTabs[1]); // Hermes
    fireEvent.click(agentTabs[0]); // OpenClaw
    expect(container.textContent).toContain("manifest/auto");
    expect(container.textContent).not.toContain("Point Hermes at the Manifest endpoint");
  });

  it("shows CLI and openclaw onboard sub-tabs", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const fullSegment = container.querySelector(".setup-segment--full");
    expect(fullSegment).not.toBeNull();
    const btns = fullSegment!.querySelectorAll(".setup-segment__btn");
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe("CLI configuration");
    expect(btns[1].textContent).toBe("openclaw onboard");
  });

  it("defaults to CLI configuration sub-tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const fullSegment = container.querySelector(".setup-segment--full");
    const btns = fullSegment!.querySelectorAll(".setup-segment__btn");
    expect(btns[0].classList.contains("setup-segment__btn--active")).toBe(true);
  });

  it("shows CLI commands on CLI sub-tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.textContent).toContain("openclaw config set");
    expect(container.textContent).toContain("openclaw gateway restart");
  });

  it("shows CLI description", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.textContent).toContain("Set the provider config and default model directly via CLI commands");
  });

  it("switches to openclaw onboard sub-tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const fullSegment = container.querySelector(".setup-segment--full");
    const btns = fullSegment!.querySelectorAll(".setup-segment__btn");
    fireEvent.click(btns[1]); // openclaw onboard
    expect(container.textContent).toContain("openclaw onboard");
    expect(container.textContent).toContain("Custom Provider");
  });

  it("shows onboard fields on wizard sub-tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const fullSegment = container.querySelector(".setup-segment--full");
    fireEvent.click(fullSegment!.querySelectorAll(".setup-segment__btn")[1]);
    const fields = container.querySelectorAll(".setup-onboard-fields__row");
    expect(fields).toHaveLength(5);
    expect(fields[0].textContent).toContain("API Base URL");
    expect(fields[0].textContent).toContain("http://localhost:3001/v1");
    expect(fields[1].textContent).toContain("API Key");
    expect(fields[2].textContent).toContain("Endpoint compatibility");
    expect(fields[2].textContent).toContain("OpenAI Chat Completions-compatible");
    expect(fields[3].textContent).toContain("Model ID");
    expect(fields[3].textContent).toContain("auto");
    expect(fields[4].textContent).toContain("Endpoint ID");
    expect(fields[4].textContent).toContain("manifest");
  });

  it("shows eye toggle on CLI sub-tab when apiKey provided", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).not.toBeNull();
  });

  it("reveals key in CLI commands when eye toggle clicked", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" />
    ));
    expect(container.textContent).toContain("mnfst_abc...");
    expect(container.textContent).not.toContain("mnfst_secret");
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_secret");
  });

  it("hides key again on second CLI eye toggle click", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} apiKey="mnfst_secret" keyPrefix="mnfst_abc" />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    fireEvent.click(container.querySelector('[aria-label="Hide API key"]')!);
    expect(container.textContent).not.toContain("mnfst_secret");
  });

  it("does not show eye toggle on CLI when no apiKey", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} keyPrefix="mnfst_abc" />
    ));
    expect(container.querySelector('[aria-label="Reveal API key"]')).toBeNull();
  });

  it("switches to Toolkits tab on click", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const segmentBtns = container.querySelectorAll(".setup-segment__btn");
    fireEvent.click(segmentBtns[1]); // Toolkits
    expect(container.querySelector(".framework-snippets")).not.toBeNull();
    expect(container.querySelector(".setup-agents-card")).toBeNull();
  });

  it("shows toolkit tabs on Toolkits tab", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    fireEvent.click(container.querySelectorAll(".setup-segment__btn")[1]);
    const tabs = container.querySelectorAll(".panel__tab");
    expect(tabs).toHaveLength(5);
    expect(tabs[0].textContent).toContain("OpenAI SDK");
    expect(tabs[1].textContent).toContain("Anthropic SDK");
  });

  it("shows full API key on Toolkits tab when provided", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} apiKey="mnfst_test_key" />
    ));
    fireEvent.click(container.querySelectorAll(".setup-segment__btn")[1]);
    expect(container.textContent).toContain("mnfst_test_key");
  });

  it("shows placeholder when no apiKey or keyPrefix", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.textContent).toContain("mnfst_YOUR_KEY");
  });

  it("has copy buttons", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const copyButtons = container.querySelectorAll(".modal-terminal__copy");
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("switches between tabs correctly", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    const segmentBtns = container.querySelectorAll(".setup-segment__btn");
    expect(container.querySelector(".setup-agents-card")).not.toBeNull();
    fireEvent.click(segmentBtns[1]); // Toolkits
    expect(container.querySelector(".framework-snippets")).not.toBeNull();
    expect(container.querySelector(".setup-agents-card")).toBeNull();
    fireEvent.click(segmentBtns[0]); // Agents
    expect(container.querySelector(".setup-agents-card")).not.toBeNull();
    expect(container.querySelector(".framework-snippets")).toBeNull();
  });

  it("uses setup-step__heading class", () => {
    const { container } = render(() => <SetupStepAddProvider {...defaultProps} />);
    expect(container.querySelector(".setup-step__heading")).not.toBeNull();
  });

  it("includes api key in CLI snippet", () => {
    const { container } = render(() => (
      <SetupStepAddProvider {...defaultProps} apiKey="mnfst_test" keyPrefix="mnfst_tes" />
    ));
    fireEvent.click(container.querySelector('[aria-label="Reveal API key"]')!);
    expect(container.textContent).toContain("mnfst_test");
  });

  describe("platform-filtered mode", () => {
    it("shows OpenClawSetup directly when platform is openclaw", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openclaw" />
      ));
      expect(container.textContent).toContain("Register Manifest in your OpenClaw config");
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for openclaw", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openclaw" />
      ));
      expect(screen.getByText("Connect your OpenClaw harness to Manifest")).toBeDefined();
    });

    it("shows HermesSetup directly when platform is hermes", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="hermes" />
      ));
      expect(container.textContent).toContain("Point Hermes at the Manifest endpoint");
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for hermes", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="hermes" />
      ));
      expect(screen.getByText("Connect your Hermes harness to Manifest")).toBeDefined();
    });

    it("shows NanobotSetup directly when platform is nanobot", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="nanobot" />
      ));
      expect(container.textContent).toContain("~/.nanobot/config.json");
      expect(container.textContent).toContain("apiBase");
      // No top-level Agents/Toolkits tabs in filtered mode.
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for nanobot", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="nanobot" />
      ));
      expect(screen.getByText("Connect your Nanobot harness to Manifest")).toBeDefined();
    });

    it("shows CraftAgentSetup directly when platform is craft", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="craft" />
      ));
      expect(container.textContent).toContain("Manifest provider preset");
      expect(container.textContent).toContain("mnfst_YOUR_KEY");
      // No top-level Agents/Toolkits tabs in filtered mode.
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for craft", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="craft" />
      ));
      expect(screen.getByText("Connect your Craft harness to Manifest")).toBeDefined();
    });

    it("shows n8n setup guidance with docs and credential values", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="n8n" keyPrefix="mnfst_abc" />
      ));
      expect(screen.getByText("Connect n8n to Manifest")).toBeDefined();
      expect(container.textContent).toContain("n8n-nodes-manifest");
      expect(container.textContent).toContain("Manifest Chat Model node");
      expect(container.textContent).toContain("Create or select Manifest credentials");
      expect(container.textContent).toContain("set the node model to auto");
      expect(container.textContent).toContain("http://localhost:3001");
      expect(container.textContent).not.toContain("http://localhost:3001/v1");
      expect(container.textContent).toContain("mnfst_abc...");
      expect(container.textContent).toContain("auto");
      expect(container.textContent).not.toContain("not bundled");
      const docsLink = container.querySelector(
        'a[href="https://docs.n8n.io/integrations/community-nodes/installation-and-management/"]',
      );
      expect(docsLink).not.toBeNull();
      expect(docsLink!.textContent).toContain("n8n community node installation docs");
      expect(
        container.querySelector('a[href="https://www.npmjs.com/package/n8n-nodes-manifest"]'),
      ).not.toBeNull();
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("reveals and hides the n8n API key", () => {
      render(() => (
        <SetupStepAddProvider
          {...defaultProps}
          platform="n8n"
          apiKey="mnfst_secret"
          keyPrefix="mnfst_sec"
        />
      ));

      expect(screen.queryByText("mnfst_secret")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Reveal API key" }));
      expect(screen.getByText("mnfst_secret")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Hide API key" }));
      expect(screen.queryByText("mnfst_secret")).toBeNull();
    });

    it("shows ClaudeCodeSetup directly when platform is claude-code", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="claude-code" />
      ));
      expect(container.textContent).toContain("~/.claude/settings.json");
      expect(container.textContent).toContain("ANTHROPIC_BASE_URL");
      // No top-level Agents/Toolkits tabs in filtered mode.
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for claude-code", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="claude-code" />
      ));
      expect(screen.getByText("Connect Claude Code to Manifest")).toBeDefined();
    });

    it("shows OpenCodeSetup directly when platform is opencode", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="opencode" />
      ));
      expect(container.textContent).toContain("~/.config/opencode/opencode.json");
      expect(container.textContent).toContain('"model": "manifest/auto"');
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for opencode", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="opencode" />
      ));
      expect(screen.getByText("Connect OpenCode to Manifest")).toBeDefined();
    });

    it("shows CodexSetup directly when platform is codex", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="codex" />
      ));
      expect(container.textContent).toContain("~/.codex/config.toml");
      expect(container.textContent).toContain('wire_api = "responses"');
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("shows correct heading for codex", () => {
      render(() => (
        <SetupStepAddProvider {...defaultProps} platform="codex" />
      ));
      expect(screen.getByText("Connect Codex to Manifest")).toBeDefined();
    });

    it("shows OpenAI SDK snippet when platform is openai-sdk", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openai-sdk" />
      ));
      expect(container.querySelector(".framework-snippets")).not.toBeNull();
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
      // Should show OpenAI-specific code
      expect(container.textContent).toContain("OpenAI");
      expect(container.textContent).toContain("client.responses.create");
      expect(container.textContent).not.toContain("chat.completions.create");
    });

    it("shows Vercel AI SDK snippet when platform is vercel-ai-sdk", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="vercel-ai-sdk" />
      ));
      expect(container.querySelector(".framework-snippets")).not.toBeNull();
      // Should show Vercel-specific code
      expect(container.textContent).toContain("ai");
    });

    it("shows LangChain snippet when platform is langchain", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="langchain" />
      ));
      expect(container.querySelector(".framework-snippets")).not.toBeNull();
      // Should show LangChain-specific code
      expect(container.textContent).toContain("ChatOpenAI");
    });

    it("shows cURL snippet when platform is curl", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="curl" />
      ));
      expect(container.querySelector(".framework-snippets")).not.toBeNull();
      expect(container.textContent).toContain("curl");
    });

    it("shows cURL snippet when platform is other", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="other" />
      ));
      expect(container.querySelector(".framework-snippets")).not.toBeNull();
      expect(container.textContent).toContain("curl");
      // No top-level Agents/Toolkits tabs
      expect(container.querySelector('[aria-label="Setup method"]')).toBeNull();
    });

    it("hides SDK tabs when platform is a specific toolkit", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openai-sdk" />
      ));
      // Should not show the SDK toolkit tab bar
      const panelTabs = container.querySelectorAll('.panel__tab');
      expect(panelTabs).toHaveLength(0);
    });

    it("shows full tabbed UI when platform is null", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform={null} />
      ));
      expect(container.querySelector(".setup-segment")).not.toBeNull();
    });

    it("still shows heading in platform-filtered mode", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openclaw" />
      ));
      expect(container.textContent).toContain("Connect your OpenClaw harness to Manifest");
    });

    it("does not show description text in filtered mode", () => {
      const { container } = render(() => (
        <SetupStepAddProvider {...defaultProps} platform="openclaw" />
      ));
      expect(container.textContent).not.toContain("Point your harness at the Manifest endpoint");
    });
  });
});
