import { describe, expect, it } from "vitest";
import type { Clock, SyncOperation } from "./model";
import {
  activeTabs,
  activeHistoryUrls,
  applyBookmarkOperations,
  applyHistoryOperations,
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

  it("merges independent history changes without replacing the whole history", () => {
    const first: SyncOperation = {
      id: "history-a",
      deviceId: "a",
      clock: clock(20),
      type: "history-delta-v2",
      added: ["https://a.example"],
      removed: [],
    };
    const second: SyncOperation = {
      id: "history-b",
      deviceId: "b",
      clock: clock(21),
      type: "history-delta-v2",
      added: ["https://b.example"],
      removed: [],
    };

    const state = applyHistoryOperations(undefined, [second, first]);
    expect(activeHistoryUrls(state!)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("keeps the latest add or removal for each history URL", () => {
    const add: SyncOperation = {
      id: "history-add",
      deviceId: "a",
      clock: clock(30),
      type: "history-delta-v2",
      added: ["https://example.com"],
      removed: [],
    };
    const remove: SyncOperation = {
      id: "history-remove",
      deviceId: "b",
      clock: clock(31),
      type: "history-delta-v2",
      added: [],
      removed: ["https://example.com"],
    };

    const state = applyHistoryOperations(undefined, [remove, add]);
    expect(activeHistoryUrls(state!)).toEqual([]);
  });

  it("ignores the legacy history snapshot format", () => {
    const legacy: SyncOperation = {
      id: "legacy-history",
      deviceId: "a",
      clock: clock(40),
      type: "history-delta",
      added: ["https://legacy.example"],
      removed: [],
    };

    expect(applyHistoryOperations(undefined, [legacy])).toBeUndefined();
  });

  it("adds a new visit after synchronized history was cleared", () => {
    const initial: SyncOperation = {
      id: "initial-history",
      deviceId: "a",
      clock: clock(50),
      type: "history-delta-v2",
      added: ["https://old.example"],
      removed: [],
    };
    const clearAndAdd: SyncOperation = {
      id: "clear-history",
      deviceId: "a",
      clock: clock(51),
      type: "history-delta-v2",
      clear: true,
      added: ["https://new.example"],
      removed: [],
    };

    const state = applyHistoryOperations(undefined, [initial, clearAndAdd]);
    expect(activeHistoryUrls(state!)).toEqual(["https://new.example"]);
  });
});
