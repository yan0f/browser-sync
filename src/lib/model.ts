export const OPERATION_FILE_PREFIX = "tabsync-ops-v1-";
export const SCHEMA_VERSION = 1;

export interface Clock {
  wallTime: number;
  counter: number;
  node: string;
}

export interface SyncedTab {
  id: string;
  url: string;
  pinned: boolean;
  position: number;
}

interface OperationBase {
  id: string;
  deviceId: string;
  clock: Clock;
}

export interface UpsertOperation extends OperationBase {
  type: "upsert";
  tab: SyncedTab;
}

export interface RemoveOperation extends OperationBase {
  type: "remove";
  tabId: string;
}

export type SyncOperation = UpsertOperation | RemoveOperation;

export interface OperationBatch {
  schemaVersion: 1;
  deviceId: string;
  createdAt: string;
  operations: SyncOperation[];
}

export interface CanonicalEntry {
  clock: Clock;
  tab: SyncedTab | null;
}

export type CanonicalState = Record<string, CanonicalEntry>;

export interface SyncStatus {
  connected: boolean;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt?: number;
  error?: string;
  tabCount: number;
  deviceId: string;
}

export type RuntimeRequest =
  | { type: "status" }
  | { type: "connect" }
  | { type: "enable" }
  | { type: "disable" }
  | { type: "sync-now" }
  | { type: "disconnect" };

export type RuntimeResponse =
  | { ok: true; status: SyncStatus }
  | { ok: false; error: string; status: SyncStatus };
