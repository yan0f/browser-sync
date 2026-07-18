import { describe, expect, it } from "vitest";
import type { Clock, SyncOperation } from "./model";
import {
  activeTabs,
  applyBookmarkOperations,
  applyOperations,
  compareClocks,
} from "./reducer";

const clock = (wallTime: number, counter = 0, node = "a"): Clock => ({
  wallTime,
  counter,
  node,
});

describe("canonical reducer", () => {
  it("keeps the newest operation regardless of replay order", () => {
    const older: SyncOperation = {
      id: "op-1",
      deviceId: "a",
      clock: clock(10),
      type: "upsert",
      tab: { id: "tab-1", url: "https://old.example", pinned: false, position: 0 },
    };
    const newer: SyncOperation = {
      id: "op-2",
      deviceId: "b",
      clock: clock(20, 0, "b"),
      type: "upsert",
      tab: { id: "tab-1", url: "https://new.example", pinned: true, position: 0 },
    };

    expect(activeTabs(applyOperations({}, [newer, older]))[0]?.url).toBe(
      "https://new.example",
    );
  });

  it("keeps a tombstone newer than an upsert", () => {
    const operations: SyncOperation[] = [
      {
        id: "op-1",
        deviceId: "a",
        clock: clock(10),
        type: "upsert",
        tab: { id: "tab-1", url: "https://example.com", pinned: false, position: 0 },
      },
      {
        id: "op-2",
        deviceId: "b",
        clock: clock(11, 0, "b"),
        type: "remove",
        tabId: "tab-1",
      },
    ];
    expect(activeTabs(applyOperations({}, operations))).toEqual([]);
  });

  it("uses node id as a deterministic tie breaker", () => {
    expect(compareClocks(clock(10, 0, "a"), clock(10, 0, "b"))).toBeLessThan(0);
  });

  it("keeps bookmark snapshots separate from tab state", () => {
    const operation: SyncOperation = {
      id: "op-bookmarks",
      deviceId: "a",
      clock: clock(12),
      type: "bookmark-snapshot",
      snapshot: {
        roots: [[{ title: "Example", url: "https://example.com" }]],
      },
    };

    expect(applyOperations({}, [operation])).toEqual({});
    expect(applyBookmarkOperations(undefined, [operation])?.snapshot).toEqual(
      operation.snapshot,
    );
  });

  it("uses the newest complete bookmark snapshot", () => {
    const older: SyncOperation = {
      id: "old",
      deviceId: "a",
      clock: clock(12),
      type: "bookmark-snapshot",
      snapshot: { roots: [[{ title: "Old", url: "https://old.example" }]] },
    };
    const newer: SyncOperation = {
      id: "new",
      deviceId: "b",
      clock: clock(13),
      type: "bookmark-snapshot",
      snapshot: { roots: [[{ title: "New", url: "https://new.example" }]] },
    };

    expect(
      applyBookmarkOperations(undefined, [newer, older])?.snapshot.roots[0]?.[0]
        ?.title,
    ).toBe("New");
  });
});
