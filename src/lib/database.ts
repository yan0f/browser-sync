import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CanonicalState, Clock, SyncOperation } from "./model";

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
  databasePromise ??= openDB<TabSyncDatabase>("tabsync", 1, {
    upgrade(db) {
      db.createObjectStore("meta");
      db.createObjectStore("mappings");
      db.createObjectStore("outbox");
      db.createObjectStore("seenFiles");
    },
  });
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
  const existing = await getMeta<string | undefined>("deviceId", undefined);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setMeta("deviceId", id);
  return id;
}

export async function isEnabled(): Promise<boolean> {
  return getMeta("enabled", false);
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await setMeta("enabled", enabled);
}

export async function getCanonicalState(): Promise<CanonicalState> {
  return getMeta("canonical", {});
}

export async function setCanonicalState(state: CanonicalState): Promise<void> {
  await setMeta("canonical", state);
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
    transaction.objectStore("meta").delete("changeToken"),
    transaction.objectStore("meta").delete("lastClock"),
    transaction.objectStore("meta").delete("cloudInitialized"),
    transaction.objectStore("meta").put(false, "enabled"),
  ]);
  await transaction.done;
}
