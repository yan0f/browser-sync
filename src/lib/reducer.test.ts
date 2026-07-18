import { describe, expect, it } from "vitest";
import type { Clock, SyncOperation } from "./model";
import { activeTabs, applyOperations, compareClocks } from "./reducer";

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
});
