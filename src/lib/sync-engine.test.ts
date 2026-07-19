import { describe, expect, it } from "vitest";
import {
  shouldApplyRemoteState,
  shouldCreateTabUpsert,
  shouldRebaseLocalChanges,
} from "./sync-engine";

describe("remote reconciliation", () => {
  it("skips stale reconciliation when polling and local events find no cloud changes", () => {
    expect(shouldApplyRemoteState(false, false)).toBe(false);
  });

  it("applies real cloud changes and explicit startup restoration", () => {
    expect(shouldApplyRemoteState(true, false)).toBe(true);
    expect(shouldApplyRemoteState(false, true)).toBe(true);
  });

  it("rebases an active local tab gesture after receiving a cloud conflict", () => {
    expect(shouldRebaseLocalChanges(true, 1)).toBe(true);
    expect(shouldRebaseLocalChanges(false, 1)).toBe(false);
    expect(shouldRebaseLocalChanges(true, 0)).toBe(false);
  });

  it("publishes an explicit ungroup gesture even when cached state already matches", () => {
    const ungrouped = {
      id: "tab-1",
      url: "https://example.com",
      pinned: false,
      position: 0,
    };

    expect(shouldCreateTabUpsert(ungrouped, ungrouped, true)).toBe(true);
    expect(
      shouldCreateTabUpsert(
        ungrouped,
        {
          ...ungrouped,
          group: { id: "group-1", color: "blue", collapsed: false },
        },
        false,
      ),
    ).toBe(true);
  });
});
