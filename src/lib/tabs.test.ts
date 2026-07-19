import { describe, expect, it, vi } from "vitest";
import type { CanonicalState } from "./model";
import {
  assignSyncedGroups,
  isSupportedUrl,
  reconcileTabGroups,
  retryTabEdit,
  sameSyncedGroup,
} from "./tabs";

describe("isSupportedUrl", () => {
  it.each(["https://example.com", "http://localhost:3000"])(
    "accepts %s",
    (url) => expect(isSupportedUrl(url)).toBe(true),
  );

  it.each(["chrome://settings", "file:///tmp/a.txt", "devtools://devtools", "not a url"])(
    "rejects %s",
    (url) => expect(isSupportedUrl(url)).toBe(false),
  );
});

describe("retryTabEdit", () => {
  it("retries while Chromium temporarily locks tabs during dragging", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await retryTabEdit(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          );
        }
        return "done";
      },
      async (delayMs) => {
        waits.push(delayMs);
      },
    );

    expect(result).toBe("done");
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("does not retry permanent tab errors", async () => {
    let attempts = 0;

    await expect(
      retryTabEdit(
        async () => {
          attempts += 1;
          throw new Error("No tab with id: 42");
        },
        async () => undefined,
      ),
    ).rejects.toThrow("No tab with id: 42");

    expect(attempts).toBe(1);
  });
});

describe("tab groups", () => {
  const tab = (id: number, groupId: number): chrome.tabs.Tab =>
    ({
      id,
      groupId,
      index: id - 1,
      pinned: false,
      highlighted: false,
      active: false,
      incognito: false,
      selected: false,
      windowId: 1,
    }) as chrome.tabs.Tab;

  const group = (id: number): chrome.tabGroups.TabGroup => ({
    id,
    windowId: 1,
    title: "Work",
    color: "blue",
    collapsed: true,
    shared: false,
  });

  it("reuses the logical group id of an already mapped tab", () => {
    const canonical: CanonicalState = {
      "tab-1": {
        clock: { wallTime: 1, counter: 0, node: "a" },
        tab: {
          id: "tab-1",
          url: "https://example.com",
          pinned: false,
          position: 0,
          group: { id: "group-logical", color: "grey", collapsed: false },
        },
      },
    };

    const result = assignSyncedGroups(
      [tab(1, 7)],
      new Map([[7, group(7)]]),
      canonical,
      new Map([["tab-1", 1]]),
      () => "new-group",
    );

    expect(result.get(7)).toEqual({
      id: "group-logical",
      title: "Work",
      color: "blue",
      collapsed: true,
    });
  });

  it("creates one logical id for all tabs in a new local group", () => {
    let created = 0;
    const result = assignSyncedGroups(
      [tab(1, 7), tab(2, 7)],
      new Map([[7, group(7)]]),
      {},
      new Map(),
      () => `new-group-${++created}`,
    );

    expect(result.get(7)?.id).toBe("new-group-1");
    expect(created).toBe(1);
  });

  it("assigns a new logical id when one synced group is split locally", () => {
    const canonical: CanonicalState = Object.fromEntries(
      ["tab-1", "tab-2"].map((id, index) => [
        id,
        {
          clock: { wallTime: 1, counter: 0, node: "a" },
          tab: {
            id,
            url: `https://${index}.example`,
            pinned: false,
            position: index,
            group: { id: "original-group", color: "blue", collapsed: false },
          },
        },
      ]),
    );

    const result = assignSyncedGroups(
      [tab(1, 7), tab(2, 8)],
      new Map([[7, group(7)], [8, group(8)]]),
      canonical,
      new Map([["tab-1", 1], ["tab-2", 2]]),
      () => "split-group",
    );

    expect(new Set([result.get(7)?.id, result.get(8)?.id])).toEqual(
      new Set(["original-group", "split-group"]),
    );
  });

  it("keeps the target group identity when a tab moves between groups", () => {
    const canonical: CanonicalState = Object.fromEntries(
      ["tab-a1", "tab-b1", "tab-b2", "tab-a2"].map((id, index) => [
        id,
        {
          clock: { wallTime: 1, counter: index, node: "a" },
          tab: {
            id,
            url: `https://${id}.example`,
            pinned: false,
            position: index,
            group: {
              id: id.includes("-a") ? "group-a" : "group-b",
              color: "blue" as const,
              collapsed: false,
            },
          },
        },
      ]),
    );

    const result = assignSyncedGroups(
      [tab(1, 8), tab(2, 8), tab(3, 8), tab(4, 7)],
      new Map([[7, group(7)], [8, group(8)]]),
      canonical,
      new Map([
        ["tab-a1", 1],
        ["tab-b1", 2],
        ["tab-b2", 3],
        ["tab-a2", 4],
      ]),
      () => "new-group",
    );

    expect(result.get(8)?.id).toBe("group-b");
    expect(result.get(7)?.id).toBe("group-a");
  });

  it("uses the stationary tab to resolve a one-to-one group move", () => {
    const canonical: CanonicalState = Object.fromEntries(
      ["tab-a", "tab-b"].map((id, index) => [
        id,
        {
          clock: { wallTime: 1, counter: index, node: "a" },
          tab: {
            id,
            url: `https://${id}.example`,
            pinned: false,
            position: index,
            group: {
              id: id === "tab-a" ? "group-a" : "group-b",
              color: "blue" as const,
              collapsed: false,
            },
          },
        },
      ]),
    );

    const result = assignSyncedGroups(
      [tab(1, 8), tab(2, 8)],
      new Map([[8, group(8)]]),
      canonical,
      new Map([["tab-a", 1], ["tab-b", 2]]),
      () => "new-group",
      new Set([1]),
    );

    expect(result.get(8)?.id).toBe("group-b");
  });

  it("detects changes to group metadata", () => {
    expect(
      sameSyncedGroup(
        { id: "g", color: "blue", collapsed: false },
        { id: "g", color: "blue", collapsed: true },
      ),
    ).toBe(false);
  });

  it("does not edit a tab group that already matches the desired state", async () => {
    const localTabs = [tab(1, 7), tab(2, 7)];
    const localGroup = group(7);
    const groupTabs = vi.fn();
    const updateGroup = vi.fn();
    const moveTabs = vi.fn();
    const ungroupTabs = vi.fn();

    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue(localTabs),
        group: groupTabs,
        move: moveTabs,
        ungroup: ungroupTabs,
      },
      tabGroups: {
        query: vi.fn().mockResolvedValue([localGroup]),
        update: updateGroup,
      },
    });

    try {
      await reconcileTabGroups(
        [
          {
            id: "tab-1",
            url: "https://one.example",
            pinned: false,
            position: 0,
            group: { id: "logical-group", title: "Work", color: "blue", collapsed: true },
          },
          {
            id: "tab-2",
            url: "https://two.example",
            pinned: false,
            position: 1,
            group: { id: "logical-group", title: "Work", color: "blue", collapsed: true },
          },
        ],
        new Map([["tab-1", 1], ["tab-2", 2]]),
      );

      expect(groupTabs).not.toHaveBeenCalled();
      expect(updateGroup).not.toHaveBeenCalled();
      expect(moveTabs).not.toHaveBeenCalled();
      expect(ungroupTabs).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
