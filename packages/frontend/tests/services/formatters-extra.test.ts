import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatCost,
  formatTrend,
  sortedHeaderEntries,
} from "../../src/services/formatters.js";

describe("formatNumber edge cases", () => {
  it("formats exactly 1000 as 1k", () => {
    expect(formatNumber(1000)).toBe("1k");
  });

  it("formats exactly 1000000 as 1M", () => {
    expect(formatNumber(1_000_000)).toBe("1M");
  });

  it("formats boundary between k and M (999999) as 1M", () => {
    expect(formatNumber(999_999)).toBe("1M");
  });

  it("formats negative numbers", () => {
    expect(formatNumber(-500)).toBe("-500");
  });

  it("formats very large millions", () => {
    expect(formatNumber(1_500_000_000)).toBe("1500M");
  });

  it("formats whole thousands without decimal", () => {
    expect(formatNumber(2000)).toBe("2k");
    expect(formatNumber(200_000)).toBe("200k");
  });

  it("formats whole millions without decimal", () => {
    expect(formatNumber(3_000_000)).toBe("3M");
  });
});

describe("formatCost edge cases", () => {
  it("formats zero cost", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats very small costs above one cent", () => {
    expect(formatCost(0.01)).toBe("$0.01");
  });

  it("returns '< $0.01' for sub-cent costs", () => {
    expect(formatCost(0.005)).toBe("< $0.01");
    expect(formatCost(0.0001)).toBe("< $0.01");
  });

  it("formats whole dollar amounts", () => {
    expect(formatCost(100)).toBe("$100.00");
  });

  it("formats costs with many decimal places (rounds to 2)", () => {
    expect(formatCost(3.456)).toBe("$3.46");
    expect(formatCost(3.454)).toBe("$3.45");
  });

  it("returns null for negative costs", () => {
    expect(formatCost(-293)).toBeNull();
    expect(formatCost(-0.005)).toBeNull();
  });
});

describe("formatTrend edge cases", () => {
  it("formats very large positive trend", () => {
    expect(formatTrend(999)).toBe("+999%");
  });

  it("formats very large negative trend", () => {
    expect(formatTrend(-100)).toBe("-100%");
  });

  it("formats fractional trend (rounds)", () => {
    expect(formatTrend(12.7)).toBe("+13%");
    expect(formatTrend(-12.3)).toBe("-12%");
  });
});

describe("sortedHeaderEntries", () => {
  it("returns an empty array for null or undefined input", () => {
    expect(sortedHeaderEntries(null)).toEqual([]);
    expect(sortedHeaderEntries(undefined)).toEqual([]);
  });

  it("sorts header entries alphabetically by key", () => {
    expect(
      sortedHeaderEntries({ "x-custom": "1", authorization: "secret", "user-agent": "curl" }),
    ).toEqual([
      ["authorization", "secret"],
      ["user-agent", "curl"],
      ["x-custom", "1"],
    ]);
  });
});
