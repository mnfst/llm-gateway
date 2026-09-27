import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";

const routerState = vi.hoisted(() => ({
  pathname: "/",
}));

vi.mock("@solidjs/router", () => ({
  useLocation: () => routerState,
}));

vi.mock("../../src/components/Header.jsx", () => ({
  default: (props: any) => (
    <div data-testid="header">
      Header
      {props.showMobileNavToggle && (
        <button
          data-testid="mobile-nav-toggle"
          aria-expanded={String(props.mobileNavOpen)}
          onClick={props.onMobileNavToggle}
        >
          Menu
        </button>
      )}
    </div>
  ),
}));

vi.mock("../../src/components/Sidebar.jsx", () => ({
  default: (props: any) => (
    <div data-testid="sidebar" data-mobile-open={props.mobileOpen ? "true" : "false"}>
      Sidebar
    </div>
  ),
}));

vi.mock("../../src/components/AuthGuard.jsx", () => ({
  default: (props: any) => <div data-testid="auth-guard">{props.children}</div>,
}));

vi.mock("../../src/services/sse.js", () => ({
  connectSse: () => () => {},
  analyticsPing: () => 0,
}));

import App from "../../src/App";

beforeEach(() => {
  sessionStorage.clear();
  routerState.pathname = "/";
});

describe("App", () => {
  it("renders the app shell", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector(".app-shell")).not.toBeNull();
  });

  it("renders AuthGuard wrapper", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="auth-guard"]')).not.toBeNull();
  });

  it("renders Header", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="header"]')).not.toBeNull();
  });

  it("renders main content area", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector(".main-content")).not.toBeNull();
  });

  it("does not show sidebar on root redirect path /", () => {
    // The root "/" is a transient redirect — sidebar is intentionally hidden
    routerState.pathname = "/";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it("does not show mobile navigation toggle on root redirect path", () => {
    routerState.pathname = "/";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="mobile-nav-toggle"]')).toBeNull();
  });
});

describe("App with authenticated paths", () => {
  it("shows sidebar on /agents/ paths", () => {
    routerState.pathname = "/agents/demo";

    const { container } = render(() => <App />);

    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("shows sidebar on /overview path", () => {
    routerState.pathname = "/overview";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("shows sidebar on /messages path", () => {
    routerState.pathname = "/messages";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("shows sidebar on /agents path (workspace list)", () => {
    routerState.pathname = "/agents";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("shows sidebar on /account path", () => {
    routerState.pathname = "/account";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("shows sidebar on /agents/:name/routing (deep agent sub-path)", () => {
    routerState.pathname = "/agents/demo/routing";
    const { container } = render(() => <App />);
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".app-body--with-sidebar")).not.toBeNull();
  });

  it("opens and closes the mobile sidebar drawer", () => {
    routerState.pathname = "/agents/demo";

    const { container } = render(() => <App />);
    const toggle = container.querySelector('[data-testid="mobile-nav-toggle"]');
    const sidebar = container.querySelector('[data-testid="sidebar"]');

    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar?.getAttribute("data-mobile-open")).toBe("false");

    fireEvent.click(toggle!);

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar?.getAttribute("data-mobile-open")).toBe("true");
    expect(container.querySelector(".mobile-nav-backdrop")).not.toBeNull();

    fireEvent.click(container.querySelector(".mobile-nav-backdrop")!);

    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar?.getAttribute("data-mobile-open")).toBe("false");
    expect(container.querySelector(".mobile-nav-backdrop")).toBeNull();
  });
});

describe("App structure", () => {
  it("renders app-body container", () => {
    const { container } = render(() => <App />);
    expect(container.querySelector(".app-body")).not.toBeNull();
  });

  it("has aria-label on main content", () => {
    const { container } = render(() => <App />);
    const main = container.querySelector('main[aria-label="Dashboard content"]');
    expect(main).not.toBeNull();
  });

  it("renders skip-to-content link", () => {
    const { container } = render(() => <App />);
    const skipLink = container.querySelector('a.skip-link[href="#main-content"]');
    expect(skipLink).not.toBeNull();
    expect(skipLink?.textContent).toBe("Skip to main content");
  });

  it("main content has matching id for skip link", () => {
    const { container } = render(() => <App />);
    const main = container.querySelector("main#main-content");
    expect(main).not.toBeNull();
  });
});
