import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import WingmanDevTools from "../../src/components/WingmanDevTools.jsx";

// Vite would inject these at build time. Vitest needs them defined manually
// before the module under test reads them.
declare global {
  // eslint-disable-next-line no-var
  var __WINGMAN_URL__: string;
  // eslint-disable-next-line no-var
  var __DEV_MODE__: boolean;
}

const STORAGE_OPEN = "manifest:wingman:open";
const STORAGE_HEIGHT = "manifest:wingman:height";

describe("WingmanDevTools", () => {
  let originalOpen: typeof window.open;

  beforeEach(() => {
    globalThis.__WINGMAN_URL__ = "";
    globalThis.__DEV_MODE__ = true;
    localStorage.clear();
    originalOpen = window.open;
    window.open = (() => null) as typeof window.open;
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        protocol: "http:",
        hostname: "localhost",
        port: "11096",
        origin: "http://localhost:11096",
      },
      writable: true,
    });
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it("renders the FAB by default and not the drawer", () => {
    const { container } = render(() => <WingmanDevTools />);
    expect(container.querySelector(".wingman-fab")).not.toBeNull();
    expect(container.querySelector(".wingman-drawer")).toBeNull();
  });

  it("opens the drawer when the FAB is clicked and persists state", async () => {
    const { container } = render(() => <WingmanDevTools />);
    const fab = container.querySelector(".wingman-fab") as HTMLButtonElement;
    await fireEvent.click(fab);
    expect(container.querySelector(".wingman-drawer")).not.toBeNull();
    expect(container.querySelector(".wingman-fab")).toBeNull();
    expect(localStorage.getItem(STORAGE_OPEN)).toBe("1");
  });

  it("closes the drawer when the close button is clicked", async () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const closeBtn = container.querySelector(
      '.wingman-drawer__icon-btn[aria-label="Close Wingman drawer"]',
    ) as HTMLButtonElement;
    await fireEvent.click(closeBtn);
    expect(container.querySelector(".wingman-drawer")).toBeNull();
    expect(container.querySelector(".wingman-fab")).not.toBeNull();
    expect(localStorage.getItem(STORAGE_OPEN)).toBe("0");
  });

  it("points the iframe at the hosted Wingman with a pre-filled baseUrl", () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const iframe = container.querySelector(
      ".wingman-drawer__frame",
    ) as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src.startsWith("https://wingman.manifest.build/")).toBe(true);
    expect(iframe.src).toContain(
      "baseUrl=" + encodeURIComponent("http://localhost:11096"),
    );
  });

  // Without this delegation Chrome denies `local-network-access` by
  // permissions policy inside a cross-origin iframe, so the permission can
  // never even be prompted for. It is only a fallback — the drawer normally
  // points at a loopback origin where no permission is involved — but if it
  // ever frames an https origin again, this is what keeps it recoverable.
  it("delegates local-network-access to the iframe", () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const iframe = container.querySelector(
      ".wingman-drawer__frame",
    ) as HTMLIFrameElement;
    expect(iframe.getAttribute("allow")).toContain("local-network-access");
  });

  it("respects a build-time __WINGMAN_URL__ override", () => {
    globalThis.__WINGMAN_URL__ = "http://wingman.test:5555";
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const iframe = container.querySelector(
      ".wingman-drawer__frame",
    ) as HTMLIFrameElement;
    expect(iframe.src.startsWith("http://wingman.test:5555/")).toBe(true);
  });

  it("clamps the stored height to the allowed range", () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    localStorage.setItem(STORAGE_HEIGHT, "999");
    const { container } = render(() => <WingmanDevTools />);
    const drawer = container.querySelector(".wingman-drawer") as HTMLElement;
    expect(drawer.style.height).toBe("90vh");
  });

  it("falls back to default height when the stored value is non-numeric", () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    localStorage.setItem(STORAGE_HEIGHT, "not-a-number");
    const { container } = render(() => <WingmanDevTools />);
    const drawer = container.querySelector(".wingman-drawer") as HTMLElement;
    expect(drawer.style.height).toBe("50vh");
  });

  it("toggles via Cmd/Ctrl+Shift+W", async () => {
    const { container } = render(() => <WingmanDevTools />);
    expect(container.querySelector(".wingman-drawer")).toBeNull();
    const event = new KeyboardEvent("keydown", {
      key: "W",
      shiftKey: true,
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    expect(container.querySelector(".wingman-drawer")).not.toBeNull();
  });

  it("closes via Escape when open", async () => {
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    expect(container.querySelector(".wingman-drawer")).not.toBeNull();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(event);
    expect(container.querySelector(".wingman-drawer")).toBeNull();
  });

  it("Escape is a no-op when the drawer is closed", () => {
    const { container } = render(() => <WingmanDevTools />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(event);
    expect(container.querySelector(".wingman-fab")).not.toBeNull();
  });

  it("opens a new tab when the external link is clicked", async () => {
    let opened: string | undefined;
    window.open = ((url?: string | URL) => {
      opened = typeof url === "string" ? url : url?.toString();
      return null;
    }) as typeof window.open;
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const link = container.querySelector(
      '.wingman-drawer__icon-btn[aria-label="Open Wingman in a new tab"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toContain("baseUrl=");
  });

  it("resizes the drawer via the top handle pointer drag", async () => {
    Object.defineProperty(window, "innerHeight", { value: 1000, writable: true });
    localStorage.setItem(STORAGE_OPEN, "1");
    const { container } = render(() => <WingmanDevTools />);
    const drawer = container.querySelector(".wingman-drawer") as HTMLElement;
    const resizer = container.querySelector(
      ".wingman-drawer__resizer",
    ) as HTMLElement;
    expect(drawer.style.height).toBe("50vh");

    // jsdom doesn't implement PointerEvent; fake one with the minimum surface
    // the component relies on (`clientY` and `preventDefault`).
    const makePointer = (type: string, clientY: number) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clientY", { value: clientY });
      return e;
    };

    resizer.dispatchEvent(makePointer("pointerdown", 500));
    document.dispatchEvent(makePointer("pointermove", 300));
    // 1000 - 300 = 700px from bottom -> 70vh
    expect(drawer.style.height).toBe("70vh");
    document.dispatchEvent(makePointer("pointerup", 300));
    // Subsequent moves after pointerup should be ignored.
    document.dispatchEvent(makePointer("pointermove", 100));
    expect(drawer.style.height).toBe("70vh");
    expect(localStorage.getItem(STORAGE_HEIGHT)).toBe("70");
  });
});
