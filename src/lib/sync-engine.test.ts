import { describe, expect, it } from "vitest";
import { shouldApplyRemoteState } from "./sync-engine";

describe("remote reconciliation", () => {
  it("skips stale reconciliation when polling and local events find no cloud changes", () => {
    expect(shouldApplyRemoteState(false, false)).toBe(false);
  });

  it("applies real cloud changes and explicit restore requests", () => {
    expect(shouldApplyRemoteState(true, false)).toBe(true);
    expect(shouldApplyRemoteState(false, true)).toBe(true);
  });
});
