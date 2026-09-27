import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";

let mockAgentName = "demo-agent";
let mockSearch = "";
vi.mock("@solidjs/router", () => ({
  useParams: () => ({ agentName: mockAgentName }),
  useLocation: () => ({ search: mockSearch }),
  Navigate: (props: any) => <div data-testid="navigate" data-href={props.href} />,
}));

import AgentMessagesRedirect from "../../src/pages/AgentMessagesRedirect.jsx";

describe("AgentMessagesRedirect", () => {
  it("redirects to the global log pre-scoped to the harness via ?agent=", () => {
    mockAgentName = "demo-agent";
    mockSearch = "";
    const { getByTestId } = render(() => <AgentMessagesRedirect />);
    expect(getByTestId("navigate").getAttribute("data-href")).toBe("/messages?agent=demo-agent");
  });

  it("URL-encodes the agent name", () => {
    mockAgentName = "my agent/v2";
    mockSearch = "";
    const { getByTestId } = render(() => <AgentMessagesRedirect />);
    expect(getByTestId("navigate").getAttribute("data-href")).toBe(
      "/messages?agent=my+agent%2Fv2",
    );
  });

  it("carries extra query params through (the ?request= drawer deep-link)", () => {
    mockAgentName = "demo-agent";
    mockSearch = "?request=msg-1";
    const { getByTestId } = render(() => <AgentMessagesRedirect />);
    expect(getByTestId("navigate").getAttribute("data-href")).toBe(
      "/messages?request=msg-1&agent=demo-agent",
    );
  });
});
