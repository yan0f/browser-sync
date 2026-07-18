import { forgetAccessToken, getAccessToken } from "./auth";
import {
  enqueueOperations,
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
  Clock,
  RuntimeResponse,
  SyncOperation,
  SyncStatus,
  SyncedTab,
} from "./model";
import { activeTabs, applyOperations, compareClocks, maxClock } from "./reducer";
import { querySupportedTabs, reconcileTabs } from "./tabs";

const SYNC_ALARM = "tabsync-poll";

class SyncEngine {
  private syncing = false;
  private active = false;
  private lastError: string | undefined;
  private dirty = false;
  private localRevision = 0;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  async ensureAlarm(): Promise<void> {
    const alarm = await chrome.alarms.get(SYNC_ALARM);
    if (!alarm) {
      await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
    }
  }

  noteLocalChange(): void {
    if (!this.active) return;
    this.dirty = true;
    this.localRevision += 1;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      void this.runQueued(() => this.sync(true));
    }, 700);
  }

  async startup(): Promise<void> {
    this.active = await isEnabled();
    if (!this.active) {
      await chrome.alarms.clear(SYNC_ALARM);
      return;
    }
    await this.ensureAlarm();
    await this.runQueued(() => this.sync(false));
  }

  async connect(): Promise<void> {
    await getAccessToken(true);
    await chrome.storage.local.set({ connected: true });
    this.lastError = undefined;
  }

  async enable(): Promise<void> {
    await getAccessToken(false);
    await setEnabled(true);
    this.active = true;
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
    });
  }

  async disable(): Promise<void> {
    await setEnabled(false);
    this.active = false;
    await chrome.alarms.clear(SYNC_ALARM);
  }

  async disconnect(): Promise<void> {
    await forgetAccessToken();
    await resetRemoteState();
    this.active = false;
    await chrome.alarms.clear(SYNC_ALARM);
    this.lastError = undefined;
  }

  async syncNow(): Promise<void> {
    if (!(await isEnabled())) throw new Error("Synchronization is disabled");
    await this.runQueued(() => this.sync(this.dirty));
  }

  async status(): Promise<SyncStatus> {
    const [settings, tabs] = await Promise.all([
      chrome.storage.local.get(["connected", "enabled", "lastSyncAt", "deviceId"]),
      querySupportedTabs(),
    ]);
    const status: SyncStatus = {
      connected: settings.connected === true,
      enabled: settings.enabled === true,
      syncing: this.syncing,
      tabCount: tabs.length,
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
      return {
        ok: false,
        error: this.lastError,
        status: await this.safeStatus(this.lastError),
      };
    }
  }

  reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private async safeStatus(cause?: string): Promise<SyncStatus> {
    try {
      return await this.status();
    } catch (error) {
      const statusError = error instanceof Error ? error.message : String(error);
      const combinedError = cause ? `${cause}; status: ${statusError}` : statusError;
      this.lastError = combinedError;
      return {
        connected: false,
        enabled: false,
        syncing: this.syncing,
        tabCount: 0,
        deviceId: "unavailable",
        error: combinedError,
      };
    }
  }

  private async runQueued(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      this.syncing = true;
      try {
        await task();
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.syncing = false;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sync(captureFirst: boolean): Promise<void> {
    if (!(await isEnabled())) return;
    let stableRevision = this.localRevision;
    if (captureFirst) {
      const capturedRevision = await this.captureAndFlushUntilStable();
      if (capturedRevision === undefined) return;
      stableRevision = capturedRevision;
    }
    await this.pullRemote();

    // A tab may be closed while an earlier upsert is being uploaded or while
    // Drive changes are being downloaded. Applying the stale canonical state
    // here would recreate that tab. The scheduled local-change pass will first
    // persist the newer browser state and reconcile safely afterwards.
    if (this.localRevision !== stableRevision) return;

    await this.applyRemoteState(await getCanonicalState());
    await this.recordLastSync();
  }

  private async captureAndFlushUntilStable(): Promise<number | undefined> {
    for (let pass = 0; pass < 3; pass += 1) {
      const revision = this.localRevision;
      await this.captureLocalChanges();
      await this.flushOutbox();
      if (revision === this.localRevision) {
        this.dirty = false;
        return revision;
      }
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
    const tabs = await querySupportedTabs();
    const mappings = new Map<string, number>();
    const operations: SyncOperation[] = [];
    for (const [position, tab] of tabs.entries()) {
      const id = crypto.randomUUID();
      mappings.set(id, tab.id!);
      operations.push(
        await this.createUpsert({
          id,
          url: tab.url!,
          pinned: Boolean(tab.pinned),
          position,
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

  private async captureLocalChanges(): Promise<void> {
    const [tabs, canonical, mappings] = await Promise.all([
      querySupportedTabs(),
      getCanonicalState(),
      getMappings(),
    ]);
    const tabsById = new Map(tabs.map((tab) => [tab.id!, tab]));
    const mappedTabIds = new Set(mappings.values());
    const operations: SyncOperation[] = [];

    for (const [logicalId, localTabId] of mappings) {
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
      };
      if (
        next.url !== current.url ||
        next.pinned !== current.pinned
      ) {
        operations.push(await this.createUpsert(next));
      }
    }

    for (const tab of tabs) {
      if (mappedTabIds.has(tab.id!)) continue;
      const logicalId = crypto.randomUUID();
      mappings.set(logicalId, tab.id!);
      operations.push(
        await this.createUpsert({
          id: logicalId,
          url: tab.url!,
          pinned: Boolean(tab.pinned),
          position: tab.index,
        }),
      );
    }

    if (operations.length > 0) {
      await enqueueOperations(operations);
      await setCanonicalState(applyOperations(canonical, operations));
    }
    await replaceMappings(mappings);
  }

  private async flushOutbox(): Promise<void> {
    const operations = await getOutbox();
    if (operations.length === 0) return;
    const file = await createOperationFile(await getDeviceId(), operations);
    await markFileSeen(file.id);
    await removeFromOutbox(operations.map((operation) => operation.id));
    await setMeta("cloudInitialized", true);
  }

  private async pullRemote(): Promise<void> {
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
    if (files.length > 0) await setMeta("cloudInitialized", true);
    for (const file of files) {
      if (await hasSeenFile(file.id)) continue;
      const batch = await downloadOperationBatch(file.id);
      canonical = applyOperations(canonical, batch.operations);
      await markFileSeen(file.id);
    }

    const remoteMaxClock = maxClock(canonical);
    const localClock = await getLastClock();
    await Promise.all([
      setCanonicalState(canonical),
      setMeta("changeToken", nextToken),
      remoteMaxClock && (!localClock || compareClocks(remoteMaxClock, localClock) > 0)
        ? setLastClock(remoteMaxClock)
        : Promise.resolve(),
    ]);
  }

  private async applyRemoteState(canonical: CanonicalState): Promise<void> {
    const mappings = await reconcileTabs(activeTabs(canonical), await getMappings());
    await replaceMappings(mappings);
  }
}

export const syncEngine = new SyncEngine();
export { SYNC_ALARM };
