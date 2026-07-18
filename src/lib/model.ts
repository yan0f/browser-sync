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

export interface SyncedBookmark {
  title: string;
  url?: string;
  children?: SyncedBookmark[];
}

export interface BookmarkSnapshot {
  roots: SyncedBookmark[][];
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

export interface BookmarkSnapshotOperation extends OperationBase {
  type: "bookmark-snapshot";
  snapshot: BookmarkSnapshot;
}

export type SyncOperation =
  | UpsertOperation
  | RemoveOperation
  | BookmarkSnapshotOperation;

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

export interface CanonicalBookmarks {
  clock: Clock;
  snapshot: BookmarkSnapshot;
}

export interface SyncStatus {
  connected: boolean;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt?: number;
  error?: string;
  tabCount: number;
  bookmarkCount: number;
  bookmarksEnabled: boolean;
  deviceId: string;
}

export type RuntimeRequest =
  | { type: "status" }
  | { type: "connect" }
  | { type: "enable" }
  | { type: "disable" }
  | { type: "sync-now" }
  | { type: "set-bookmarks-enabled"; enabled: boolean }
  | { type: "disconnect" };

export type RuntimeResponse =
  | { ok: true; status: SyncStatus }
  | { ok: false; error: string; status: SyncStatus };
