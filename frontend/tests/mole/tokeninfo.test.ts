import { describe, it, expect } from "vitest";
import { fmtUsd, shortAddr } from "@/lib/chain/tokenInfo";

describe("tokenInfo formatters (picker market-data display)", () => {
  it("fmtUsd renders compact magnitudes", () => {
    expect(fmtUsd(1.5e9)).toBe("$1.50B");
    expect(fmtUsd(131_000_000)).toBe("$131.00M");
    expect(fmtUsd(4_800_000)).toBe("$4.80M");
    expect(fmtUsd(12_300)).toBe("$12.3K");
    expect(fmtUsd(5)).toBe("$5.00");
  });

  it("fmtUsd handles missing/invalid values", () => {
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(NaN)).toBe("—");
    expect(fmtUsd(Infinity)).toBe("—");
  });

  it("shortAddr truncates long addresses and leaves short ones", () => {
    expect(shortAddr("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")).toBe("0x0Bd7…AD73");
    expect(shortAddr("0x1234")).toBe("0x1234");
    expect(shortAddr(undefined)).toBe("");
  });
});
