import { describe, it, expect } from "vitest";
import {
  isRemoteWingman,
  resolveWingmanDrawerUrl,
} from "../wingman-dev-proxy";

describe("isRemoteWingman", () => {
  it("treats the hosted SPA as remote", () => {
    expect(isRemoteWingman("https://wingman.manifest.build")).toBe(true);
  });

  it("treats a local Wingman checkout as not remote", () => {
    expect(isRemoteWingman("http://localhost:3002")).toBe(false);
    expect(isRemoteWingman("http://127.0.0.1:3002")).toBe(false);
  });
});

describe("resolveWingmanDrawerUrl", () => {
  // The regression this whole plugin exists for: framing the hosted HTTPS SPA
  // makes every call from it to a localhost gateway a local-network request,
  // which Chrome blocks and reports as a CORS failure.
  it("never points the drawer at a public https origin", () => {
    const url = resolveWingmanDrawerUrl("https://wingman.manifest.build", 3002);
    expect(url).toBe("http://localhost:3002");
    expect(url.startsWith("https://")).toBe(false);
  });

  it("uses the configured port", () => {
    expect(resolveWingmanDrawerUrl("https://wingman.manifest.build", 41999)).toBe(
      "http://localhost:41999",
    );
  });

  it("leaves a loopback upstream alone", () => {
    expect(resolveWingmanDrawerUrl("http://localhost:3002", 3002)).toBe(
      "http://localhost:3002",
    );
    expect(resolveWingmanDrawerUrl("http://wingman.test:5555", 3002)).toBe(
      "http://wingman.test:5555",
    );
  });
});
