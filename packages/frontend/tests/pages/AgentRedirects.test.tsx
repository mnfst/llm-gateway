import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";

// Mock params with mutable state so individual tests can override agentName
const mockParams = { agentName: "demo-agent" };

vi.mock("@solidjs/router", () => ({
  Navigate: (props: any) => <div data-testid="navigate" data-href={props.href} />,
  useParams: () => mockParams,
  useLocation: () => ({ search: "" }),
}));

import AgentLimitsRedirect from "../../src/pages/AgentLimitsRedirect";
import AgentMessagesRedirect from "../../src/pages/AgentMessagesRedirect";

describe("AgentLimitsRedirect", () => {
  beforeEach(() => {
    mockParams.agentName = "demo-agent";
  });

  it("redirects /limits to /guardrails for the current agent", () => {
    const { container } = render(() => <AgentLimitsRedirect />);
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate).not.toBeNull();
    expect(navigate?.getAttribute("data-href")).toBe("/harnesses/demo-agent/guardrails");
  });

  it("encodes agent names with special characters correctly", () => {
    mockParams.agentName = "my agent";
    const { container } = render(() => <AgentLimitsRedirect />);
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-href")).toBe("/harnesses/my%20agent/guardrails");
  });
});

describe("AgentMessagesRedirect", () => {
  beforeEach(() => {
    mockParams.agentName = "demo-agent";
  });

  it("redirects /harnesses/:name/messages to global /messages pre-filtered to the agent", () => {
    const { container } = render(() => <AgentMessagesRedirect />);
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate).not.toBeNull();
    expect(navigate?.getAttribute("data-href")).toBe("/messages?agent=demo-agent");
  });

  it("encodes agent names with special characters correctly", () => {
    mockParams.agentName = "my agent";
    const { container } = render(() => <AgentMessagesRedirect />);
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-href")).toBe("/messages?agent=my+agent");
  });

  it("normalizes an already-encoded route param instead of double-encoding", () => {
    mockParams.agentName = "my%20agent";
    const { container } = render(() => <AgentMessagesRedirect />);
    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-href")).toBe("/messages?agent=my+agent");
  });
});
