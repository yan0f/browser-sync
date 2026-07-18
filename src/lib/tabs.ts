import type { SyncedTab } from "./model";

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

function sameTab(local: chrome.tabs.Tab, desired: SyncedTab): boolean {
  return local.url === desired.url && Boolean(local.pinned) === desired.pinned;
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
        await chrome.tabs.update(mapped.id!, {
          url: desired.url,
          pinned: desired.pinned,
        });
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
  if (extraIds.length > 0) await chrome.tabs.remove(extraIds);

  return mappings;
}
