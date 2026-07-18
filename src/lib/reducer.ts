import type {
  CanonicalState,
  CanonicalBookmarks,
  CanonicalHistory,
  Clock,
  SyncOperation,
  SyncedTab,
} from "./model";

export function compareClocks(left: Clock, right: Clock): number {
  if (left.wallTime !== right.wallTime) {
    return left.wallTime - right.wallTime;
  }
  if (left.counter !== right.counter) {
    return left.counter - right.counter;
  }
  return left.node.localeCompare(right.node);
}

export function applyOperations(
  initial: CanonicalState,
  operations: readonly SyncOperation[],
): CanonicalState {
  const state = { ...initial };

  for (const operation of operations) {
    if (
      operation.type === "bookmark-snapshot" ||
      operation.type === "history-delta" ||
      operation.type === "history-delta-v2"
    ) {
      continue;
    }
    const tabId = operation.type === "upsert" ? operation.tab.id : operation.tabId;
    const current = state[tabId];
    if (current && compareClocks(operation.clock, current.clock) <= 0) {
      continue;
    }

    state[tabId] = {
      clock: operation.clock,
      tab: operation.type === "upsert" ? operation.tab : null,
    };
  }

  return state;
}

export function applyHistoryOperations(
  initial: CanonicalHistory | undefined,
  operations: readonly SyncOperation[],
): CanonicalHistory | undefined {
  let state = initial;
  for (const operation of operations) {
    if (operation.type !== "history-delta-v2") continue;
    state = { ...(state ?? {}) };
    if (operation.clear) {
      for (const [url, current] of Object.entries(state)) {
        if (compareClocks(operation.clock, current.clock) > 0) {
          state[url] = { clock: operation.clock, present: false };
        }
      }
    }
    for (const url of operation.added) {
      const current = state[url];
      const comparison = current
        ? compareClocks(operation.clock, current.clock)
        : 1;
      if (!current || comparison > 0 || (comparison === 0 && !current.present)) {
        state[url] = { clock: operation.clock, present: true };
      }
    }
    for (const url of operation.removed) {
      const current = state[url];
      if (!current || compareClocks(operation.clock, current.clock) > 0) {
        state[url] = { clock: operation.clock, present: false };
      }
    }
  }
  return state;
}

export function activeHistoryUrls(state: CanonicalHistory): string[] {
  return Object.entries(state)
    .filter(([, entry]) => entry.present)
    .map(([url]) => url)
    .sort();
}

export function maxHistoryClock(state: CanonicalHistory): Clock | undefined {
  let result: Clock | undefined;
  for (const entry of Object.values(state)) {
    if (!result || compareClocks(entry.clock, result) > 0) result = entry.clock;
  }
  return result;
}

export function applyBookmarkOperations(
  initial: CanonicalBookmarks | undefined,
  operations: readonly SyncOperation[],
): CanonicalBookmarks | undefined {
  let state = initial;
  for (const operation of operations) {
    if (operation.type !== "bookmark-snapshot") continue;
    if (state && compareClocks(operation.clock, state.clock) <= 0) continue;
    state = { clock: operation.clock, snapshot: operation.snapshot };
  }
  return state;
}

export function activeTabs(state: CanonicalState): SyncedTab[] {
  return Object.values(state)
    .flatMap((entry) => (entry.tab ? [entry.tab] : []))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function maxClock(state: CanonicalState): Clock | undefined {
  let result: Clock | undefined;
  for (const entry of Object.values(state)) {
    if (!result || compareClocks(entry.clock, result) > 0) {
      result = entry.clock;
    }
  }
  return result;
}
