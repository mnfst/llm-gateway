import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

let mockPathname = "/overview";

vi.mock("@solidjs/router", () => ({
  A: (props: any) => {
    // Access classList to trigger coverage of classList expressions
    const cl = props.classList;
    const classes = [props.class || ""];
    if (cl) {
      for (const [key, val] of Object.entries(cl)) {
        if (val) classes.push(key);
      }
    }
    return (
      <a
        href={props.href}
        class={classes.join(" ").trim()}
        aria-current={props["aria-current"]}
        onClick={props.onClick}
      >
        {props.children}
      </a>
    );
  },
  useLocation: () => ({ get pathname() { return mockPathname; } }),
}));

const mockGetBillingStatus = vi.fn();
vi.mock("../../src/services/api/billing.js", () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

// Local providers only exist on self-hosted installs; the Sidebar hides the
// Local nav entry in cloud. Default to self-hosted so the legacy link
// assertions keep applying; cloud tests flip the flag.
let mockIsSelfHosted = true;
// MCP is on by default; an install served over plain HTTP runs without it and
// the nav entry goes with it.
let mockMcpEnabled = true;
vi.mock("../../src/services/setup-status.js", () => ({
  checkIsSelfHosted: () => Promise.resolve(mockIsSelfHosted),
  checkMcpEnabled: () => Promise.resolve(mockMcpEnabled),
}));

// Stub the create-harness modal so the Sidebar test stays isolated from the
// modal's own dependency tree; we only assert that the + button opens it.
const mockAddModal = vi.fn();
vi.mock("../../src/components/AddAgentModal.jsx", async () => {
  const { Show } = await import("solid-js");
  return {
    default: (props: any) => (
      // Read props.open reactively (Show tracks the `when` accessor) so the stub
      // re-renders when the Sidebar toggles addModalOpen.
      <Show
        when={(() => {
          mockAddModal(props.open);
          return props.open;
        })()}
      >
        <div data-testid="add-agent-modal" />
      </Show>
    ),
  };
});

import Sidebar from "../../src/components/Sidebar";

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mockPathname = "/overview";
  mockIsSelfHosted = true;
  mockGetBillingStatus.mockResolvedValue({
    enabled: false,
    plan: "free",
    requests: { used: null, limit: null, periodEnd: null },
  });
});

describe("Sidebar — global nav links", () => {
  it("renders Overview link", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("Overview")).toBeDefined();
  });

  it("renders Requests link", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("Requests")).toBeDefined();
  });

  it("renders provider section links (Local resolves async, self-hosted)", async () => {
    render(() => <Sidebar />);
    expect(screen.getByText("PROVIDERS")).toBeDefined();
    expect(screen.getByText("Subscriptions")).toBeDefined();
    expect(screen.getByText("Usage-based")).toBeDefined();
    await waitFor(() => expect(screen.getByText("Local")).toBeDefined());
  });

  it("hides the Local link in cloud", async () => {
    mockIsSelfHosted = false;
    const { container } = render(() => <Sidebar />);
    // Wait for the self-hosted resource to settle (Usage-based is always present).
    await waitFor(() => expect(screen.getByText("Usage-based")).toBeDefined());
    await Promise.resolve();
    expect(container.querySelector('a[href="/providers/local"]')).toBeNull();
    expect(container.textContent).not.toContain("Local");
  });

  it("renders the Harnesses nav link under Requests", () => {
    const { container } = render(() => <Sidebar />);
    const links = Array.from(container.querySelectorAll("a.sidebar__link")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links.indexOf("/harnesses")).toBe(links.indexOf("/messages") + 1);
  });

  it("renders the TOOLS section with Playground link", () => {
    const { container } = render(() => <Sidebar />);
    expect(screen.getByText("TOOLS")).toBeDefined();
    expect(container.querySelector('a[href="/playground"]')).not.toBeNull();
  });

  it("does not render legacy MONITORING/MANAGE/RESOURCES sections", () => {
    const { container } = render(() => <Sidebar />);
    expect(container.textContent).not.toContain("MONITORING");
    expect(container.textContent).not.toContain("MANAGE");
    expect(container.textContent).not.toContain("RESOURCES");
  });

  it("global links point to global routes", async () => {
    const { container } = render(() => <Sidebar />);
    expect(container.querySelector('a[href="/overview"]')).not.toBeNull();
    expect(container.querySelector('a[href="/messages"]')).not.toBeNull();
    expect(container.querySelector('a[href="/providers/subscriptions"]')).not.toBeNull();
    expect(container.querySelector('a[href="/providers/usage-based"]')).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('a[href="/providers/local"]')).not.toBeNull(),
    );
    expect(container.querySelector('a[href="/playground"]')).not.toBeNull();
  });

  it("keeps exactly the expected sidebar__link set", async () => {
    const { container } = render(() => <Sidebar />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/providers/local"]')).not.toBeNull(),
    );
    const links = Array.from(container.querySelectorAll("a.sidebar__link")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual([
      "/overview",
      "/messages",
      "/harnesses",
      "/providers/local",
      "/providers/usage-based",
      "/providers/subscriptions",
      "/integrations/mcp",
      "/integrations/cli",
      "/playground",
    ]);
  });

  it("hides the MCP entry when the backend runs without the MCP server", async () => {
    mockMcpEnabled = false;
    try {
      const { container } = render(() => <Sidebar />);
      await waitFor(() =>
        expect(container.querySelector('a[href="/integrations/mcp"]')).toBeNull(),
      );
      // The rest of the Integrations section stays.
      expect(container.querySelector('a[href="/integrations/cli"]')).not.toBeNull();
    } finally {
      mockMcpEnabled = true;
    }
  });

  it("shows the Integrations entries with their New pills", async () => {
    const { container } = render(() => <Sidebar />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/providers/local"]')).not.toBeNull(),
    );
    const mcp = container.querySelector('a[href="/integrations/mcp"]');
    const cli = container.querySelector('a[href="/integrations/cli"]');
    expect(mcp?.textContent).toContain("MCP server");
    expect(cli?.textContent).toContain("CLI");
    expect(mcp?.querySelector(".sidebar__badge")?.textContent).toBe("New");
    expect(cli?.querySelector(".sidebar__badge")?.textContent).toBe("New");
  });
});

describe("Sidebar — global nav active state", () => {
  it("marks Overview active only on exact /overview path", () => {
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/overview"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("marks Messages active on /messages", () => {
    mockPathname = "/messages";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/messages"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("marks provider links active on provider pages (prefix match)", () => {
    mockPathname = "/providers/usage-based";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/providers/usage-based"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("marks Subscriptions active on /providers/subscriptions", () => {
    mockPathname = "/providers/subscriptions";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/providers/subscriptions"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("marks Local active on /providers/local", async () => {
    mockPathname = "/providers/local";
    const { container } = render(() => <Sidebar />);
    await waitFor(() => {
      const link = container.querySelector('a[href="/providers/local"]');
      expect(link?.getAttribute("aria-current")).toBe("page");
    });
  });

  it("marks Playground active on /playground", () => {
    mockPathname = "/playground";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/playground"]');
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("does not mark Overview active when on /messages", () => {
    mockPathname = "/messages";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a[href="/overview"]');
    expect(link?.getAttribute("aria-current")).not.toBe("page");
  });
});

describe("Sidebar — harnesses nav link", () => {
  it("renders Harnesses as a nav link to /harnesses with the create button beside it", () => {
    const { container } = render(() => <Sidebar />);
    const row = container.querySelector(".sidebar__link-row");
    expect(row).not.toBeNull();
    const link = row!.querySelector('a.sidebar__link[href="/harnesses"]');
    expect(link?.textContent).toBe("Harnesses");
    expect(row!.querySelector("button.sidebar__section-add")).not.toBeNull();
  });

  it("marks the link active on /harnesses and its subpages", () => {
    mockPathname = "/harnesses/alpha/routing";
    const { container } = render(() => <Sidebar />);
    const link = container.querySelector('a.sidebar__link[href="/harnesses"]');
    expect(link?.classList.contains("active")).toBe(true);
    expect(link?.getAttribute("aria-current")).toBe("page");
  });

  it("does not render the old per-agent switcher", () => {
    const { container } = render(() => <Sidebar />);
    expect(container.querySelector(".sidebar__agents-list")).toBeNull();
    expect(container.querySelector(".sidebar__section-caret")).toBeNull();
  });
});

describe("Sidebar — create-harness modal", () => {
  it("the + create button is always in the DOM and focusable (not hover-gated)", () => {
    const { container } = render(() => <Sidebar />);
    const addBtn = container.querySelector(".sidebar__section-add") as HTMLButtonElement;
    // Always rendered (not conditionally mounted on hover) and a real button,
    // so it is reachable by keyboard focus and touch.
    expect(addBtn).not.toBeNull();
    expect(addBtn.tagName).toBe("BUTTON");
    expect(addBtn.type).toBe("button");
    expect(addBtn.getAttribute("aria-label")).toBe("Create new harness");
    // It is focusable: focusing it makes it the active element.
    addBtn.focus();
    expect(document.activeElement).toBe(addBtn);
  });

  it("opens the AddAgentModal when the + button is clicked", async () => {
    const { container } = render(() => <Sidebar />);
    expect(container.querySelector('[data-testid="add-agent-modal"]')).toBeNull();

    const addBtn = container.querySelector(".sidebar__section-add") as HTMLButtonElement;
    await fireEvent.click(addBtn);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="add-agent-modal"]')).not.toBeNull();
    });
    expect(mockAddModal).toHaveBeenCalledWith(true);
  });

  it("clicking + opens the modal without triggering navigation", async () => {
    const onNavigate = vi.fn();
    const { container } = render(() => <Sidebar onNavigate={onNavigate} />);
    const addBtn = container.querySelector(".sidebar__section-add") as HTMLButtonElement;
    await fireEvent.click(addBtn);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("Sidebar — structure and interaction", () => {
  it("has nav element with aria-label", () => {
    const { container } = render(() => <Sidebar />);
    const nav = container.querySelector("nav.sidebar");
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute("aria-label")).toBe("Navigation");
  });

  it("applies the mobile open class", () => {
    const { container } = render(() => <Sidebar mobileOpen />);
    const nav = container.querySelector("nav.sidebar");
    expect(nav?.classList.contains("sidebar--mobile-open")).toBe(true);
  });

  it("calls onNavigate when a sidebar link is clicked", async () => {
    const onNavigate = vi.fn();
    const { container } = render(() => <Sidebar onNavigate={onNavigate} />);
    const link = container.querySelector("a.sidebar__link");

    expect(link).not.toBeNull();
    link!.addEventListener("click", (event) => event.preventDefault(), { once: true });

    await fireEvent.click(link!);

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("calls onNavigate when the Harnesses link is clicked", async () => {
    const onNavigate = vi.fn();
    const { container } = render(() => <Sidebar onNavigate={onNavigate} />);
    const item = container.querySelector('a.sidebar__link[href="/harnesses"]') as HTMLAnchorElement;
    item.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("does not render the old Feedback section", () => {
    const { container } = render(() => <Sidebar />);
    expect(container.querySelector("a.sidebar__feedback")).toBeNull();
  });
});

describe("Sidebar — usage card", () => {
  beforeEach(() => {
    // The usage meter only occupies the bottom-left slot in cloud; self-hosted
    // always shows the Autofix card there.
    mockIsSelfHosted = false;
  });
  afterEach(() => {
    mockIsSelfHosted = true;
  });

  it("renders free-plan usage and the near-limit warning state", async () => {
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: "free",
      requests: { used: 8_500, limit: 10_000, periodEnd: null },
    });

    const { container } = render(() => <Sidebar />);

    await screen.findByText(/8,500/);
    expect(container.querySelector(".sidebar-usage__count--danger")).not.toBeNull();
    expect(container.querySelector(".sidebar-usage__fill--danger")).not.toBeNull();
    expect(container.textContent).toContain(
      "You're limited to 10,000 requests this month. Upgrade for unlimited.",
    );
    expect(container.querySelector('a[href="/upgrade"]')).not.toBeNull();
  });

  it("renders the reached-limit warning state", async () => {
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: "free",
      requests: { used: 10_001, limit: 10_000, periodEnd: null },
    });

    const { container } = render(() => <Sidebar />);

    await screen.findByText(/10,001/);
    expect(container.textContent).toContain(
      "You've reached your monthly limit. Requests are being blocked.",
    );
    expect(container.querySelector(".sidebar-usage__fill--danger")).not.toBeNull();
  });

  it("hides the usage card when the billing fetch fails (fail-soft fallback)", async () => {
    mockGetBillingStatus.mockRejectedValue(new Error("boom"));
    const { container } = render(() => <Sidebar />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".sidebar-usage")).toBeNull();
  });

  it("renders the warning fill before the danger threshold", async () => {
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: "free",
      requests: { used: 5_500, limit: 10_000, periodEnd: null },
    });

    const { container } = render(() => <Sidebar />);

    await screen.findByText(/5,500/);
    expect(container.querySelector(".sidebar-usage__fill--warning")).not.toBeNull();
    expect(container.querySelector(".sidebar-usage__fill--danger")).toBeNull();
  });
});

describe("Sidebar — Autofix announcement card", () => {
  it("always renders the Autofix announcement card", async () => {
    const { container } = render(() => <Sidebar />);
    await screen.findByText("Make sure your APIs no longer crash");
    expect(container.querySelector(".sidebar-autofix")).not.toBeNull();
  });

  it("renders the Autofix announcement card in cloud too", async () => {
    mockIsSelfHosted = false;
    const { container } = render(() => <Sidebar />);
    await screen.findByText("Make sure your APIs no longer crash");
    expect(container.querySelector(".sidebar-autofix")).not.toBeNull();
  });
});
