import { forgetAccessToken, getAccessToken } from "./auth";
import {
  enqueueOperations,
  getCanonicalBookmarks,
  getCanonicalHistory,
  getCanonicalState,
  getDeviceId,
  getLastClock,
  getMappings,
  getMeta,
  getOutbox,
  hasSeenFile,
  isEnabled,
  markFileSeen,
  removeFromOutbox,
  replaceMappings,
  resetRemoteState,
  setCanonicalState,
  setCanonicalBookmarks,
  setCanonicalHistory,
  setEnabled,
  setLastClock,
  setMeta,
} from "./database";
import {
  createOperationFile,
  downloadOperationBatch,
  getStartPageToken,
  listAllOperationFiles,
  listChangedOperationFiles,
} from "./drive";
import type {
  CanonicalState,
  BookmarkSnapshot,
  CanonicalHistory,
  Clock,
  RuntimeResponse,
  SyncOperation,
  SyncStatus,
  SyncedTab,
} from "./model";
import {
  activeTabs,
  activeHistoryUrls,
  applyBookmarkOperations,
  applyHistoryOperations,
  applyOperations,
  compareClocks,
  maxClock,
  maxHistoryClock,
} from "./reducer";
import {
  assignSyncedGroups,
  isSupportedUrl,
  querySupportedTabs,
  queryTabGroups,
  reconcileTabs,
  sameSyncedGroup,
} from "./tabs";
import {
  bookmarkCount,
  captureBookmarks,
  reconcileBookmarks,
  sameBookmarkSnapshot,
} from "./bookmarks";
import { queryHistoryUrls, reconcileHistory } from "./history";
import { updateToolbarStatus } from "./action-status";
import { errorDetails, logDiagnostic, logError, logInfo } from "./diagnostics";

const SYNC_ALARM = "browsersync-poll";

export function shouldApplyRemoteState(
  remoteChanged: boolean,
  forceApply: boolean,
): boolean {
  return remoteChanged || forceApply;
}

export function shouldRebaseLocalChanges(
  remoteChanged: boolean,
  changedTabCount: number,
): boolean {
  return remoteChanged && changedTabCount > 0;
}

export function shouldCreateTabUpsert(
  next: SyncedTab,
  current: SyncedTab,
  force: boolean,
): boolean {
  return (
    force ||
    next.url !== current.url ||
    next.pinned !== current.pinned ||
    !sameSyncedGroup(next.group, current.group)
  );
}

interface LocalCaptureContext {
  revision: number;
  changedTabIds: Set<number>;
  movedTabIds: Set<number>;
  ungroupedTabIds: Set<number>;
}

class SyncEngine {
  private syncing = false;
  private active = false;
  private bookmarksActive = false;
  private applyingBookmarks = false;
  private historyActive = false;
  private applyingHistory = false;
  private applyingTabs = false;
  private pendingHistoryAdded = new Set<string>();
  private pendingHistoryRemoved = new Set<string>();
  private pendingHistoryClear = false;
  private pendingHistoryRevision = 0;
  private lastError: string | undefined;
  private dirty = false;
  private localRevision = 0;
  private pendingLocalSources = new Set<string>();
  private changedTabIds = new Set<number>();
  private recentlyMovedTabIds = new Set<number>();
  private explicitlyUngroupedTabIds = new Set<number>();
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  async ensureAlarm(): Promise<void> {
    const alarm = await chrome.alarms.get(SYNC_ALARM);
    if (!alarm) {
      await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
    }
  }

  noteLocalChange(source = "unknown"): void {
    if (!this.active) return;
    this.dirty = true;
    this.localRevision += 1;
    this.pendingLocalSources.add(source);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      const sources = [...this.pendingLocalSources];
      this.pendingLocalSources.clear();
      logInfo("sync.local_changes", {
        revision: this.localRevision,
        sources,
      });
      void this.runQueued(() => this.sync(true), "local_changes").catch((error) =>
        this.reportError(error),
      );
    }, 700);
  }

  noteTabGroupChange(tabId: number, groupId: number): void {
    if (!this.active || this.applyingTabs) return;
    this.changedTabIds.add(tabId);
    this.recentlyMovedTabIds.add(tabId);
    if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      this.explicitlyUngroupedTabIds.add(tabId);
    }
    this.noteLocalChange("tabs.group_changed");
  }

  noteTabChange(tabId: number, source: string): void {
    if (!this.active || this.applyingTabs) return;
    this.changedTabIds.add(tabId);
    this.noteLocalChange(source);
  }

  noteTabStructureChange(source: string): void {
    if (this.applyingTabs) return;
    this.noteLocalChange(source);
  }

  noteBookmarkChange(): void {
    if (!this.bookmarksActive || this.applyingBookmarks) return;
    this.noteLocalChange("bookmarks");
  }

  noteHistoryVisited(item: chrome.history.HistoryItem): void {
    if (!this.historyActive || this.applyingHistory) return;
    if (!isSupportedUrl(item.url)) return;
    this.pendingHistoryRemoved.delete(item.url);
    this.pendingHistoryAdded.add(item.url);
    this.pendingHistoryRevision += 1;
    this.noteLocalChange("history.visited");
  }

  noteHistoryRemoved(result: chrome.history.RemovedResult): void {
    if (!this.historyActive || this.applyingHistory) return;
    if (result.allHistory) {
      this.pendingHistoryClear = true;
      this.pendingHistoryAdded.clear();
      this.pendingHistoryRemoved.clear();
    } else {
      for (const url of result.urls ?? []) {
        if (!isSupportedUrl(url)) continue;
        this.pendingHistoryAdded.delete(url);
        this.pendingHistoryRemoved.add(url);
      }
    }
    this.pendingHistoryRevision += 1;
    this.noteLocalChange("history.removed");
  }

  async startup(): Promise<void> {
    logInfo("worker.startup");
    const { browserSyncInitialized, bookmarksEnabled, historyEnabled } =
      await chrome.storage.local.get([
        "browserSyncInitialized",
        "bookmarksEnabled",
        "historyEnabled",
      ]);
    if (browserSyncInitialized !== true) {
      await chrome.storage.local.set({
        browserSyncInitialized: true,
        enabled: false,
      });
    }
    this.active = browserSyncInitialized === true && (await isEnabled());
    /* Settings are intentionally retained across development resets. */
    this.bookmarksActive = this.active && bookmarksEnabled === true;
    this.historyActive = this.active && historyEnabled === true;
    if (!this.active) {
      logInfo("worker.idle", { reason: "sync_disabled" });
      await chrome.alarms.clear(SYNC_ALARM);
      await this.updateToolbar();
      return;
    }
    logInfo("worker.active", {
      bookmarks: this.bookmarksActive,
      history: this.historyActive,
    });
    await this.ensureAlarm();
    await this.runQueued(() => this.sync(false, true), "startup");
  }

  async connect(): Promise<void> {
    logInfo("auth.connect_started");
    await getAccessToken(true);
    await chrome.storage.local.set({ connected: true });
    this.lastError = undefined;
    logInfo("auth.connected");
    await this.updateToolbar();
  }

  async enable(): Promise<void> {
    await getAccessToken(false);
    await setEnabled(true);
    this.active = true;
    const { bookmarksEnabled, historyEnabled } = await chrome.storage.local.get([
      "bookmarksEnabled",
      "historyEnabled",
    ]);
    this.bookmarksActive = bookmarksEnabled === true;
    this.historyActive = historyEnabled === true;
    await this.ensureAlarm();
    await this.runQueued(async () => {
      await this.pullRemote();
      let canonical = await getCanonicalState();
      if (!(await getMeta("cloudInitialized", false))) {
        await this.seedFromLocalTabs();
        await this.flushOutbox();
        canonical = await getCanonicalState();
      }
      await this.applyRemoteState(canonical);
      await this.recordLastSync();
    }, "enable");
  }

  async disable(): Promise<void> {
    await setEnabled(false);
    this.active = false;
    this.bookmarksActive = false;
    this.historyActive = false;
    await chrome.alarms.clear(SYNC_ALARM);
    logInfo("sync.disabled");
    await this.updateToolbar();
  }

  async disconnect(): Promise<void> {
    await forgetAccessToken();
    await resetRemoteState();
    this.active = false;
    this.bookmarksActive = false;
    this.historyActive = false;
    await chrome.alarms.clear(SYNC_ALARM);
    this.lastError = undefined;
    logInfo("auth.disconnected");
    await this.updateToolbar();
  }

  async syncNow(reason: "manual" | "alarm" = "manual"): Promise<void> {
    if (!(await isEnabled())) throw new Error("Synchronization is disabled");
    await this.runQueued(() => this.sync(this.dirty), reason);
  }

  async setBookmarksEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.local.set({ bookmarksEnabled: enabled });
    this.bookmarksActive = enabled && (await isEnabled());
    if (!this.bookmarksActive) return;

    await this.runQueued(async () => {
      await this.pullRemote();
      const remote = await getCanonicalBookmarks();
      if (remote) {
        await this.applyRemoteBookmarks(remote.snapshot);
      } else {
        await this.captureBookmarkChanges();
        await this.flushOutbox();
      }
      await this.recordLastSync();
    }, "bookmarks_enabled");
  }

  async setHistoryEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.local.set({ historyEnabled: enabled });
    this.historyActive = enabled && (await isEnabled());
    if (!this.historyActive) return;

    await this.runQueued(async () => {
      await this.pullRemote();
      const remote = await getCanonicalHistory();
      if (remote !== undefined) {
        await this.applyRemoteHistory(remote);
      } else {
        await this.captureHistoryChanges();
        await this.flushOutbox();
      }
      await this.recordLastSync();
    }, "history_enabled");
  }

  async status(): Promise<SyncStatus> {
    const settings = await chrome.storage.local.get([
      "connected",
      "enabled",
      "bookmarksEnabled",
      "historyEnabled",
      "lastSyncAt",
      "deviceId",
    ]);
    const [tabs, bookmarks, history] = await Promise.all([
      querySupportedTabs(),
      captureBookmarks(),
      settings.historyEnabled === true
        ? queryHistoryUrls()
        : Promise.resolve(new Set<string>()),
    ]);
    const status: SyncStatus = {
      connected: settings.connected === true,
      enabled: settings.enabled === true,
      syncing: this.syncing,
      tabCount: tabs.length,
      bookmarkCount: bookmarkCount(bookmarks),
      bookmarksEnabled: settings.bookmarksEnabled === true,
      historyCount: history.size,
      historyEnabled: settings.historyEnabled === true,
      deviceId:
        typeof settings.deviceId === "string" ? settings.deviceId : "not-initialized",
    };
    if (typeof settings.lastSyncAt === "number") status.lastSyncAt = settings.lastSyncAt;
    if (this.lastError !== undefined) status.error = this.lastError;
    return status;
  }

  async respond(action: () => Promise<void>): Promise<RuntimeResponse> {
    try {
      await action();
      return { ok: true, status: await this.safeStatus() };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.updateToolbar();
      return {
        ok: false,
        error: this.lastError,
        status: await this.safeStatus(this.lastError),
      };
    }
  }

  reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    logError("sync.unhandled_error", error);
    void this.updateToolbar();
  }

  private async safeStatus(cause?: string): Promise<SyncStatus> {
    try {
      return await this.status();
    } catch (error) {
      const statusError = error instanceof Error ? error.message : String(error);
      const combinedError = cause ? `${cause}; status: ${statusError}` : statusError;
      this.lastError = combinedError;
      await this.updateToolbar();
      return {
        connected: false,
        enabled: false,
        syncing: this.syncing,
        tabCount: 0,
        bookmarkCount: 0,
        bookmarksEnabled: false,
        historyCount: 0,
        historyEnabled: false,
        deviceId: "unavailable",
        error: combinedError,
      };
    }
  }

  private async runQueued(
    task: () => Promise<void>,
    reason: string,
  ): Promise<void> {
    const next = this.queue.then(async () => {
      const startedAt = Date.now();
      this.syncing = true;
      logInfo("sync.started", { reason });
      await this.updateToolbar();
      try {
        await task();
        this.lastError = undefined;
        logInfo("sync.completed", {
          reason,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        logDiagnostic("error", "sync.failed", {
          reason,
          durationMs: Date.now() - startedAt,
          ...errorDetails(error),
        });
        throw error;
      } finally {
        this.syncing = false;
        await this.updateToolbar();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async updateToolbar(): Promise<void> {
    try {
      const { connected, enabled } = await chrome.storage.local.get([
        "connected",
        "enabled",
      ]);
      await updateToolbarStatus({
        connected: connected === true,
        enabled: enabled === true,
        syncing: this.syncing,
        ...(this.lastError ? { error: this.lastError } : {}),
      });
    } catch (error) {
      logError("toolbar.update_failed", error);
    }
  }

  private async sync(captureFirst: boolean, forceApply = false): Promise<void> {
    if (!(await isEnabled())) return;
    let stableRevision = this.localRevision;
    let captureContext: LocalCaptureContext | undefined;
    if (captureFirst) {
      captureContext = await this.captureAndFlushUntilStable();
      if (captureContext === undefined) return;
      stableRevision = captureContext.revision;
    }
    const remoteChanged = await this.pullRemote();

    // A tab may be closed while an earlier upsert is being uploaded or while
    // Drive changes are being downloaded. Applying the stale canonical state
    // here would recreate that tab. The scheduled local-change pass will first
    // persist the newer browser state and reconcile safely afterwards.
    if (this.localRevision !== stableRevision) return;

    if (
      captureContext &&
      shouldRebaseLocalChanges(
        remoteChanged,
        captureContext.changedTabIds.size,
      )
    ) {
      await this.captureLocalChanges({
        tabIds: captureContext.changedTabIds,
        movedTabIds: captureContext.movedTabIds,
        forceTabIds: captureContext.ungroupedTabIds,
        includeAuxiliary: false,
        scope: "remote_rebase",
      });
      await this.flushOutbox();
      if (this.localRevision !== stableRevision) return;
    }

    if (!shouldApplyRemoteState(remoteChanged, forceApply)) {
      logInfo("sync.reconcile_skipped", { reason: "no_remote_changes" });
      await this.recordLastSync();
      return;
    }

    await this.applyRemoteState(await getCanonicalState());
    await this.recordLastSync();
  }

  private async captureAndFlushUntilStable(): Promise<
    LocalCaptureContext | undefined
  > {
    const changedTabIds = new Set<number>();
    const movedTabIds = new Set<number>();
    const ungroupedTabIds = new Set<number>();
    for (let pass = 0; pass < 3; pass += 1) {
      const revision = this.localRevision;
      for (const tabId of this.changedTabIds) changedTabIds.add(tabId);
      for (const tabId of this.recentlyMovedTabIds) movedTabIds.add(tabId);
      for (const tabId of this.explicitlyUngroupedTabIds) {
        ungroupedTabIds.add(tabId);
      }
      this.changedTabIds.clear();
      this.recentlyMovedTabIds.clear();
      this.explicitlyUngroupedTabIds.clear();
      await this.captureLocalChanges({
        movedTabIds,
        forceTabIds: ungroupedTabIds,
      });
      await this.flushOutbox();
      if (revision === this.localRevision) {
        this.dirty = false;
        return { revision, changedTabIds, movedTabIds, ungroupedTabIds };
      }
    }
    for (const tabId of changedTabIds) this.changedTabIds.add(tabId);
    for (const tabId of movedTabIds) this.recentlyMovedTabIds.add(tabId);
    for (const tabId of ungroupedTabIds) {
      this.explicitlyUngroupedTabIds.add(tabId);
    }
    return undefined;
  }

  private async recordLastSync(): Promise<void> {
    await chrome.storage.local.set({ lastSyncAt: Date.now() });
  }

  private async nextClock(): Promise<Clock> {
    const deviceId = await getDeviceId();
    const previous = await getLastClock();
    const wallTime = Math.max(Date.now(), previous?.wallTime ?? 0);
    const clock: Clock = {
      wallTime,
      counter: previous?.wallTime === wallTime ? previous.counter + 1 : 0,
      node: deviceId,
    };
    await setLastClock(clock);
    return clock;
  }

  private async createUpsert(tab: SyncedTab): Promise<SyncOperation> {
    return {
      id: crypto.randomUUID(),
      deviceId: await getDeviceId(),
      clock: await this.nextClock(),
      type: "upsert",
      tab,
    };
  }

  private async createRemove(tabId: string): Promise<SyncOperation> {
    return {
      id: crypto.randomUUID(),
      deviceId: await getDeviceId(),
      clock: await this.nextClock(),
      type: "remove",
      tabId,
    };
  }

  private async seedFromLocalTabs(): Promise<void> {
    const [tabs, localGroups] = await Promise.all([
      querySupportedTabs(),
      queryTabGroups(),
    ]);
    const mappings = new Map<string, number>();
    const operations: SyncOperation[] = [];
    const logicalIds = new Map<number, string>();
    for (const tab of tabs) {
      const id = crypto.randomUUID();
      mappings.set(id, tab.id!);
      logicalIds.set(tab.id!, id);
    }
    const groups = assignSyncedGroups(tabs, localGroups, {}, mappings);
    for (const [position, tab] of tabs.entries()) {
      const id = logicalIds.get(tab.id!)!;
      const group =
        tab.groupId === undefined ? undefined : groups.get(tab.groupId);
      operations.push(
        await this.createUpsert({
          id,
          url: tab.url!,
          pinned: Boolean(tab.pinned),
          position,
          ...(group ? { group } : {}),
        }),
      );
    }
    const canonical = applyOperations(await getCanonicalState(), operations);
    await Promise.all([
      replaceMappings(mappings),
      enqueueOperations(operations),
      setCanonicalState(canonical),
    ]);
    if (operations.length === 0) {
      const file = await createOperationFile(await getDeviceId(), []);
      await markFileSeen(file.id);
      await setMeta("cloudInitialized", true);
    }
  }

  private async captureLocalChanges(
    options: {
      tabIds?: ReadonlySet<number>;
      movedTabIds?: ReadonlySet<number>;
      forceTabIds?: ReadonlySet<number>;
      includeAuxiliary?: boolean;
      scope?: string;
    } = {},
  ): Promise<void> {
    const {
      tabIds,
      movedTabIds = new Set<number>(),
      forceTabIds = new Set<number>(),
      includeAuxiliary = true,
      scope = "all",
    } = options;
    const [tabs, canonical, mappings, localGroups] = await Promise.all([
      querySupportedTabs(),
      getCanonicalState(),
      getMappings(),
      queryTabGroups(),
    ]);
    const tabsById = new Map(tabs.map((tab) => [tab.id!, tab]));
    const mappedTabIds = new Set(mappings.values());
    const groups = assignSyncedGroups(
      tabs,
      localGroups,
      canonical,
      mappings,
      undefined,
      movedTabIds,
    );
    const operations: SyncOperation[] = [];

    for (const [logicalId, localTabId] of mappings) {
      if (tabIds && !tabIds.has(localTabId)) continue;
      const local = tabsById.get(localTabId);
      const current = canonical[logicalId]?.tab;
      if (!current) continue;
      if (!local) {
        operations.push(await this.createRemove(logicalId));
        continue;
      }
      const next: SyncedTab = {
        id: logicalId,
        url: local.url!,
        pinned: Boolean(local.pinned),
        position: local.index,
        ...(local.groupId !== undefined && groups.has(local.groupId)
          ? { group: groups.get(local.groupId)! }
          : {}),
      };
      if (shouldCreateTabUpsert(next, current, forceTabIds.has(localTabId))) {
        operations.push(await this.createUpsert(next));
      }
    }

    for (const tab of tabs) {
      if (tabIds && !tabIds.has(tab.id!)) continue;
      if (mappedTabIds.has(tab.id!)) continue;
      const logicalId = crypto.randomUUID();
      mappings.set(logicalId, tab.id!);
      const group =
        tab.groupId === undefined ? undefined : groups.get(tab.groupId);
      operations.push(
        await this.createUpsert({
          id: logicalId,
          url: tab.url!,
          pinned: Boolean(tab.pinned),
          position: tab.index,
          ...(group ? { group } : {}),
        }),
      );
    }

    if (operations.length > 0) {
      await enqueueOperations(operations);
      await setCanonicalState(applyOperations(canonical, operations));
    }
    logInfo("sync.local_captured", {
      tabs: tabs.length,
      groups: localGroups.size,
      operations: operations.length,
      scope,
    });
    await replaceMappings(mappings);
    if (includeAuxiliary && this.bookmarksActive) {
      await this.captureBookmarkChanges();
    }
    if (includeAuxiliary && this.historyActive) {
      await this.captureHistoryChanges();
    }
  }

  private async captureBookmarkChanges(): Promise<void> {
    const [snapshot, current] = await Promise.all([
      captureBookmarks(),
      getCanonicalBookmarks(),
    ]);
    if (current && sameBookmarkSnapshot(snapshot, current.snapshot)) return;

    const operation: SyncOperation = {
      id: crypto.randomUUID(),
      deviceId: await getDeviceId(),
      clock: await this.nextClock(),
      type: "bookmark-snapshot",
      snapshot,
    };
    await Promise.all([
      enqueueOperations([operation]),
      setCanonicalBookmarks({ clock: operation.clock, snapshot }),
    ]);
  }

  private async captureHistoryChanges(): Promise<void> {
    const current = await getCanonicalHistory();
    const revision = this.pendingHistoryRevision;
    const clear = this.pendingHistoryClear;
    const added = [...this.pendingHistoryAdded];
    const removed = [...this.pendingHistoryRemoved];
    if (
      current !== undefined &&
      !clear &&
      added.length === 0 &&
      removed.length === 0
    ) {
      return;
    }

    const operation: SyncOperation = {
      id: crypto.randomUUID(),
      deviceId: await getDeviceId(),
      clock: await this.nextClock(),
      type: "history-delta",
      added,
      removed,
      ...(clear ? { clear: true } : {}),
    };
    await Promise.all([
      enqueueOperations([operation]),
      setCanonicalHistory(applyHistoryOperations(current, [operation])),
    ]);
    if (revision === this.pendingHistoryRevision) {
      this.pendingHistoryAdded.clear();
      this.pendingHistoryRemoved.clear();
      this.pendingHistoryClear = false;
    }
  }

  private async flushOutbox(): Promise<void> {
    const operations = await getOutbox();
    if (operations.length === 0) return;
    const file = await createOperationFile(await getDeviceId(), operations);
    await markFileSeen(file.id);
    await removeFromOutbox(operations.map((operation) => operation.id));
    await setMeta("cloudInitialized", true);
    logInfo("drive.outbox_uploaded", {
      operations: operations.length,
      fileId: file.id,
    });
  }

  private async pullRemote(): Promise<boolean> {
    let changeToken = await getMeta<string | undefined>("changeToken", undefined);
    let files;
    let nextToken: string;
    if (!changeToken) {
      nextToken = await getStartPageToken();
      files = await listAllOperationFiles();
    } else {
      const changes = await listChangedOperationFiles(changeToken);
      files = changes.files;
      nextToken = changes.nextToken;
    }

    let canonical = await getCanonicalState();
    let canonicalBookmarks = await getCanonicalBookmarks();
    let canonicalHistory = await getCanonicalHistory();
    if (files.length > 0) await setMeta("cloudInitialized", true);
    logInfo("drive.changes_received", {
      mode: changeToken ? "incremental" : "full",
      files: files.length,
    });
    let downloadedFiles = 0;
    let downloadedOperations = 0;
    for (const file of files) {
      if (await hasSeenFile(file.id)) continue;
      const batch = await downloadOperationBatch(file.id);
      downloadedFiles += 1;
      downloadedOperations += batch.operations.length;
      canonical = applyOperations(canonical, batch.operations);
      canonicalBookmarks = applyBookmarkOperations(canonicalBookmarks, batch.operations);
      canonicalHistory = applyHistoryOperations(canonicalHistory, batch.operations);
      await markFileSeen(file.id);
    }

    const tabClock = maxClock(canonical);
    const bookmarkClock = canonicalBookmarks?.clock;
    const historyClock = canonicalHistory
      ? maxHistoryClock(canonicalHistory)
      : undefined;
    let remoteMaxClock =
      tabClock && bookmarkClock
        ? compareClocks(tabClock, bookmarkClock) >= 0
          ? tabClock
          : bookmarkClock
        : tabClock ?? bookmarkClock;
    if (
      historyClock &&
      (!remoteMaxClock || compareClocks(historyClock, remoteMaxClock) > 0)
    ) {
      remoteMaxClock = historyClock;
    }
    const localClock = await getLastClock();
    await Promise.all([
      setCanonicalState(canonical),
      setCanonicalBookmarks(canonicalBookmarks),
      setCanonicalHistory(canonicalHistory),
      setMeta("changeToken", nextToken),
      remoteMaxClock && (!localClock || compareClocks(remoteMaxClock, localClock) > 0)
        ? setLastClock(remoteMaxClock)
        : Promise.resolve(),
    ]);
    logInfo("drive.operations_applied", {
      files: downloadedFiles,
      operations: downloadedOperations,
    });
    return downloadedOperations > 0;
  }

  private async applyRemoteState(canonical: CanonicalState): Promise<void> {
    const tabs = activeTabs(canonical);
    this.applyingTabs = true;
    try {
      const mappings = await reconcileTabs(tabs, await getMappings());
      await replaceMappings(mappings);
      logInfo("sync.remote_applied", { tabs: tabs.length });
    } finally {
      this.applyingTabs = false;
    }
    if (this.bookmarksActive) {
      const bookmarks = await getCanonicalBookmarks();
      if (bookmarks) await this.applyRemoteBookmarks(bookmarks.snapshot);
    }
    if (this.historyActive) {
      const history = await getCanonicalHistory();
      if (history !== undefined) await this.applyRemoteHistory(history);
    }
  }

  private async applyRemoteBookmarks(snapshot: BookmarkSnapshot): Promise<void> {
    this.applyingBookmarks = true;
    try {
      await reconcileBookmarks(snapshot);
    } finally {
      this.applyingBookmarks = false;
    }
  }

  private async applyRemoteHistory(history: CanonicalHistory): Promise<void> {
    this.applyingHistory = true;
    try {
      const removed = Object.entries(history)
        .filter(([, entry]) => !entry.present)
        .map(([url]) => url);
      await reconcileHistory(activeHistoryUrls(history), removed);
    } finally {
      this.applyingHistory = false;
    }
  }
}

export const syncEngine = new SyncEngine();
export { SYNC_ALARM };
