import { describe, expect, it } from "vitest";
import {
  shouldApplyRemoteState,
  shouldRebaseLocalChanges,
} from "./sync-engine";

describe("remote reconciliation", () => {
  it("skips stale reconciliation when polling and local events find no cloud changes", () => {
    expect(shouldApplyRemoteState(false, false)).toBe(false);
  });

  it("applies real cloud changes and explicit restore requests", () => {
    expect(shouldApplyRemoteState(true, false)).toBe(true);
    expect(shouldApplyRemoteState(false, true)).toBe(true);
  });

  it("rebases an active local tab gesture after receiving a cloud conflict", () => {
    expect(shouldRebaseLocalChanges(true, 1)).toBe(true);
    expect(shouldRebaseLocalChanges(false, 1)).toBe(false);
    expect(shouldRebaseLocalChanges(true, 0)).toBe(false);
  });
});
