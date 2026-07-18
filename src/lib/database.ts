import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  CanonicalBookmarks,
  CanonicalHistory,
  CanonicalState,
  Clock,
  SyncOperation,
} from "./model";

interface TabSyncDatabase extends DBSchema {
  meta: {
    key: string;
    value: unknown;
  };
  mappings: {
    key: string;
    value: number;
  };
  outbox: {
    key: string;
    value: SyncOperation;
  };
  seenFiles: {
    key: string;
    value: boolean;
  };
}

let databasePromise: Promise<IDBPDatabase<TabSyncDatabase>> | undefined;

function database(): Promise<IDBPDatabase<TabSyncDatabase>> {
  if (!databasePromise) {
    const opening = openDB<TabSyncDatabase>("tabsync", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("mappings")) db.createObjectStore("mappings");
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox");
        if (!db.objectStoreNames.contains("seenFiles")) db.createObjectStore("seenFiles");
      },
      blocked() {
        console.error("TabSync IndexedDB opening is blocked by another extension context");
      },
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Не удалось открыть локальную базу TabSync за 3 секунды")),
        3_000,
      );
    });
    databasePromise = Promise.race([opening, timeout])
      .finally(() => clearTimeout(timeoutId))
      .catch((error) => {
        databasePromise = undefined;
        throw error;
      });
  }
  return databasePromise;
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const value = await (await database()).get("meta", key);
  return value === undefined ? fallback : (value as T);
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await (await database()).put("meta", value, key);
}

export async function getDeviceId(): Promise<string> {
  const { deviceId: existing } = await chrome.storage.local.get("deviceId");
  if (typeof existing === "string" && existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

export async function isEnabled(): Promise<boolean> {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled === true;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ enabled });
}

export async function getCanonicalState(): Promise<CanonicalState> {
  return getMeta("canonical", {});
}

export async function setCanonicalState(state: CanonicalState): Promise<void> {
  await setMeta("canonical", state);
}

export async function getCanonicalBookmarks(): Promise<CanonicalBookmarks | undefined> {
  return getMeta<CanonicalBookmarks | undefined>("canonicalBookmarks", undefined);
}

export async function setCanonicalBookmarks(
  state: CanonicalBookmarks | undefined,
): Promise<void> {
  const db = await database();
  if (state === undefined) await db.delete("meta", "canonicalBookmarks");
  else await db.put("meta", state, "canonicalBookmarks");
}

export async function getCanonicalHistory(): Promise<CanonicalHistory | undefined> {
  return getMeta<CanonicalHistory | undefined>("canonicalHistoryV2", undefined);
}

export async function setCanonicalHistory(
  state: CanonicalHistory | undefined,
): Promise<void> {
  const db = await database();
  if (state === undefined) await db.delete("meta", "canonicalHistoryV2");
  else await db.put("meta", state, "canonicalHistoryV2");
}

export async function getLastClock(): Promise<Clock | undefined> {
  return getMeta<Clock | undefined>("lastClock", undefined);
}

export async function setLastClock(clock: Clock): Promise<void> {
  await setMeta("lastClock", clock);
}

export async function getMappings(): Promise<Map<string, number>> {
  const db = await database();
  const keys = await db.getAllKeys("mappings");
  const values = await db.getAll("mappings");
  return new Map(keys.map((key, index) => [key, values[index]!]));
}

export async function replaceMappings(mappings: Map<string, number>): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mappings", "readwrite");
  await transaction.store.clear();
  for (const [logicalId, tabId] of mappings) {
    await transaction.store.put(tabId, logicalId);
  }
  await transaction.done;
}

export async function enqueueOperations(operations: SyncOperation[]): Promise<void> {
  if (operations.length === 0) return;
  const transaction = (await database()).transaction("outbox", "readwrite");
  for (const operation of operations) {
    await transaction.store.put(operation, operation.id);
  }
  await transaction.done;
}

export async function getOutbox(): Promise<SyncOperation[]> {
  return (await database()).getAll("outbox");
}

export async function removeFromOutbox(operationIds: string[]): Promise<void> {
  const transaction = (await database()).transaction("outbox", "readwrite");
  for (const id of operationIds) {
    await transaction.store.delete(id);
  }
  await transaction.done;
}

export async function hasSeenFile(fileId: string): Promise<boolean> {
  return (await database()).get("seenFiles", fileId).then(Boolean);
}

export async function markFileSeen(fileId: string): Promise<void> {
  await (await database()).put("seenFiles", true, fileId);
}

export async function resetRemoteState(): Promise<void> {
  const db = await database();
  const transaction = db.transaction(
    ["meta", "mappings", "outbox", "seenFiles"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("mappings").clear(),
    transaction.objectStore("outbox").clear(),
    transaction.objectStore("seenFiles").clear(),
    transaction.objectStore("meta").delete("canonical"),
    transaction.objectStore("meta").delete("canonicalBookmarks"),
    transaction.objectStore("meta").delete("canonicalHistory"),
    transaction.objectStore("meta").delete("canonicalHistoryV2"),
    transaction.objectStore("meta").delete("changeToken"),
    transaction.objectStore("meta").delete("lastClock"),
    transaction.objectStore("meta").delete("cloudInitialized"),
  ]);
  await transaction.done;
  await chrome.storage.local.set({ enabled: false, connected: false });
}
