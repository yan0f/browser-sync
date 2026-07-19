import type {
  CanonicalState,
  SyncedTab,
  SyncedTabGroup,
  SyncedTabGroupColor,
} from "./model";
import { logWarn } from "./diagnostics";

const NO_GROUP_ID = -1;
const TAB_EDIT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_200] as const;

function isTemporaryTabEditError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Tabs cannot be edited right now")
  );
}

export async function retryTabEdit<T>(
  operation: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (const [index, delayMs] of TAB_EDIT_RETRY_DELAYS_MS.entries()) {
    try {
      return await operation();
    } catch (error) {
      if (!isTemporaryTabEditError(error)) throw error;
      logWarn("tabs.edit_temporarily_blocked", {
        attempt: index + 1,
        retryInMs: delayMs,
      });
      await wait(delayMs);
    }
  }
  return operation();
}

export function isSupportedUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function querySupportedTabs(): Promise<chrome.tabs.Tab[]> {
  return (await chrome.tabs.query({})).filter(
    (tab) => !tab.incognito && isSupportedUrl(tab.url) && tab.id !== undefined,
  );
}

export async function queryTabGroups(): Promise<Map<number, chrome.tabGroups.TabGroup>> {
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((group) => [group.id, group]));
}

function sameTab(local: chrome.tabs.Tab, desired: SyncedTab): boolean {
  return local.url === desired.url && Boolean(local.pinned) === desired.pinned;
}

export function sameSyncedGroup(
  left: SyncedTabGroup | undefined,
  right: SyncedTabGroup | undefined,
): boolean {
  return (
    left?.id === right?.id &&
    left?.title === right?.title &&
    left?.color === right?.color &&
    left?.collapsed === right?.collapsed
  );
}

export function assignSyncedGroups(
  tabs: readonly chrome.tabs.Tab[],
  groups: ReadonlyMap<number, chrome.tabGroups.TabGroup>,
  canonical: CanonicalState,
  mappings: ReadonlyMap<string, number>,
  createId: () => string = () => crypto.randomUUID(),
  recentlyMovedTabIds: ReadonlySet<number> = new Set(),
): Map<number, SyncedTabGroup> {
  const tabsById = new Map(tabs.map((tab) => [tab.id!, tab]));
  const logicalIds = new Map<number, string>();
  const usedLogicalIds = new Set<string>();
  const overlap = new Map<string, { count: number; stableCount: number }>();

  for (const [logicalTabId, localTabId] of mappings) {
    const localGroupId = tabsById.get(localTabId)?.groupId;
    const logicalGroupId = canonical[logicalTabId]?.tab?.group?.id;
    if (
      localGroupId !== undefined &&
      localGroupId !== NO_GROUP_ID &&
      logicalGroupId
    ) {
      const key = `${localGroupId}\u0000${logicalGroupId}`;
      const current = overlap.get(key) ?? { count: 0, stableCount: 0 };
      overlap.set(key, {
        count: current.count + 1,
        stableCount:
          current.stableCount + (recentlyMovedTabIds.has(localTabId) ? 0 : 1),
      });
    }
  }

  const candidates = [...overlap.entries()]
    .map(([key, counts]) => {
      const separator = key.indexOf("\u0000");
      return {
        localGroupId: Number(key.slice(0, separator)),
        logicalGroupId: key.slice(separator + 1),
        ...counts,
      };
    })
    .sort(
      (left, right) =>
        right.stableCount - left.stableCount || right.count - left.count,
    );
  for (const candidate of candidates) {
    if (
      logicalIds.has(candidate.localGroupId) ||
      usedLogicalIds.has(candidate.logicalGroupId)
    ) {
      continue;
    }
    logicalIds.set(candidate.localGroupId, candidate.logicalGroupId);
    usedLogicalIds.add(candidate.logicalGroupId);
  }

  const result = new Map<number, SyncedTabGroup>();
  for (const tab of tabs) {
    if (
      tab.groupId === undefined ||
      tab.groupId === NO_GROUP_ID ||
      result.has(tab.groupId)
    ) {
      continue;
    }
    const group = groups.get(tab.groupId);
    if (!group) continue;
    const title = group.title;
    result.set(tab.groupId, {
      id: logicalIds.get(tab.groupId) ?? createId(),
      color: group.color as SyncedTabGroupColor,
      collapsed: group.collapsed,
      ...(title ? { title } : {}),
    });
  }
  return result;
}

async function moveTabsToWindow(
  tabIds: number[],
  targetWindowId: number,
  localById: ReadonlyMap<number, chrome.tabs.Tab>,
): Promise<void> {
  const foreignIds = tabIds.filter(
    (tabId) => localById.get(tabId)?.windowId !== targetWindowId,
  );
  if (foreignIds.length > 0) {
    await retryTabEdit(() =>
      chrome.tabs.move(foreignIds, { windowId: targetWindowId, index: -1 }),
    );
  }
}

export async function reconcileTabGroups(
  desiredTabs: readonly SyncedTab[],
  mappings: ReadonlyMap<string, number>,
): Promise<void> {
  const [allTabs, allGroups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);
  const localById = new Map(
    allTabs.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab] as const])),
  );
  const localGroups = new Map(allGroups.map((group) => [group.id, group]));
  const desiredGroups = new Map<
    string,
    { metadata: SyncedTabGroup; tabIds: number[] }
  >();
  const ungroupedIds: number[] = [];

  for (const desired of desiredTabs) {
    const tabId = mappings.get(desired.id);
    if (tabId === undefined) continue;
    if (!desired.group) {
      if (localById.get(tabId)?.groupId !== NO_GROUP_ID) {
        ungroupedIds.push(tabId);
      }
      continue;
    }
    const entry = desiredGroups.get(desired.group.id);
    if (entry) entry.tabIds.push(tabId);
    else desiredGroups.set(desired.group.id, { metadata: desired.group, tabIds: [tabId] });
  }

  if (ungroupedIds.length > 0) {
    await retryTabEdit(() =>
      chrome.tabs.ungroup(ungroupedIds as [number, ...number[]]),
    );
  }

  const usedLocalGroups = new Set<number>();
  for (const { metadata, tabIds } of desiredGroups.values()) {
    const firstTab = localById.get(tabIds[0]!);
    if (firstTab?.windowId === undefined) continue;
    await moveTabsToWindow(tabIds, firstTab.windowId, localById);

    const tabIdSet = new Set(tabIds);
    const candidate = tabIds
      .map((tabId) => localById.get(tabId)?.groupId)
      .find(
        (groupId): groupId is number =>
          groupId !== undefined &&
          groupId !== NO_GROUP_ID &&
          !usedLocalGroups.has(groupId) &&
          tabIds.some((tabId) => {
            const tab = localById.get(tabId);
            return tab?.groupId === groupId && tab.windowId === firstTab.windowId;
          }) &&
          allTabs.every((tab) => tab.groupId !== groupId || tabIdSet.has(tab.id!)),
      );

    let groupId: number;
    if (candidate === undefined) {
      groupId = await retryTabEdit(() =>
        chrome.tabs.group({
          tabIds: tabIds as [number, ...number[]],
          createProperties: { windowId: firstTab.windowId },
        }),
      );
    } else {
      groupId = candidate;
      const missingTabIds = tabIds.filter(
        (tabId) => localById.get(tabId)?.groupId !== candidate,
      );
      if (missingTabIds.length > 0) {
        await retryTabEdit(() =>
          chrome.tabs.group({
            tabIds: missingTabIds as [number, ...number[]],
            groupId: candidate,
          }),
        );
      }
    }
    usedLocalGroups.add(groupId);
    const localGroup = localGroups.get(groupId);
    if (
      !localGroup ||
      (localGroup.title ?? "") !== (metadata.title ?? "") ||
      localGroup.color !== metadata.color ||
      localGroup.collapsed !== metadata.collapsed
    ) {
      await retryTabEdit(() =>
        chrome.tabGroups.update(groupId, {
          title: metadata.title ?? "",
          color: metadata.color,
          collapsed: metadata.collapsed,
        }),
      );
    }
  }
}

export async function reconcileTabs(
  desiredTabs: SyncedTab[],
  previousMappings: Map<string, number>,
): Promise<Map<string, number>> {
  const localTabs = await querySupportedTabs();
  const localById = new Map(localTabs.map((tab) => [tab.id!, tab]));
  const usedLocalIds = new Set<number>();
  const mappings = new Map<string, number>();

  for (const desired of desiredTabs) {
    const mappedId = previousMappings.get(desired.id);
    const mapped = mappedId === undefined ? undefined : localById.get(mappedId);
    if (mapped) {
      if (!sameTab(mapped, desired)) {
        await retryTabEdit(() =>
          chrome.tabs.update(mapped.id!, {
            url: desired.url,
            pinned: desired.pinned,
          }),
        );
      }
      mappings.set(desired.id, mapped.id!);
      usedLocalIds.add(mapped.id!);
    }
  }

  for (const desired of desiredTabs) {
    if (mappings.has(desired.id)) continue;
    const match = localTabs.find(
      (tab) => !usedLocalIds.has(tab.id!) && sameTab(tab, desired),
    );
    if (match) {
      mappings.set(desired.id, match.id!);
      usedLocalIds.add(match.id!);
    }
  }

  for (const desired of desiredTabs) {
    if (mappings.has(desired.id)) continue;
    const created = await chrome.tabs.create({
      url: desired.url,
      active: false,
      pinned: desired.pinned,
    });
    if (created.id !== undefined) {
      mappings.set(desired.id, created.id);
      usedLocalIds.add(created.id);
    }
  }

  const extraIds = localTabs
    .map((tab) => tab.id!)
    .filter((tabId) => !usedLocalIds.has(tabId));
  if (extraIds.length > 0) {
    await retryTabEdit(() => chrome.tabs.remove(extraIds));
  }

  await reconcileTabGroups(desiredTabs, mappings);

  return mappings;
}
