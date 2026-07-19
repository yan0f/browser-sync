import { defineBackground } from "wxt/utils/define-background";
import type { RuntimeRequest, RuntimeResponse } from "../lib/model";
import { SYNC_ALARM, syncEngine } from "../lib/sync-engine";

export default defineBackground(() => {
  const noteLocalChange = (source: string) => () =>
    syncEngine.noteLocalChange(source);

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) syncEngine.noteTabChange(tab.id, "tabs.created");
  });
  chrome.tabs.onRemoved.addListener((tabId) =>
    syncEngine.noteTabChange(tabId, "tabs.removed"),
  );
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.groupId !== undefined) {
      syncEngine.noteTabGroupChange(tabId);
    } else if (
      changeInfo.url !== undefined ||
      changeInfo.pinned !== undefined
    ) {
      syncEngine.noteTabChange(tabId, "tabs.updated");
    }
  });

  chrome.tabGroups.onCreated.addListener(noteLocalChange("groups.created"));
  chrome.tabGroups.onRemoved.addListener(noteLocalChange("groups.removed"));
  chrome.tabGroups.onUpdated.addListener(noteLocalChange("groups.updated"));
  chrome.tabGroups.onMoved.addListener(noteLocalChange("groups.moved"));

  const noteBookmarkChange = () => syncEngine.noteBookmarkChange();
  chrome.bookmarks.onCreated.addListener(noteBookmarkChange);
  chrome.bookmarks.onRemoved.addListener(noteBookmarkChange);
  chrome.bookmarks.onChanged.addListener(noteBookmarkChange);
  chrome.bookmarks.onMoved.addListener(noteBookmarkChange);

  chrome.history.onVisited.addListener((item) => syncEngine.noteHistoryVisited(item));
  chrome.history.onVisitRemoved.addListener((result) =>
    syncEngine.noteHistoryRemoved(result),
  );

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void syncEngine.syncNow(false).catch(() => undefined);
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    void syncEngine.startup().catch((error) => syncEngine.reportError(error));
  });
  chrome.runtime.onMessage.addListener(
    (request: RuntimeRequest, _sender, sendResponse: (response: RuntimeResponse) => void) => {
      const response = (() => {
        switch (request.type) {
          case "status":
            return syncEngine.respond(async () => undefined);
          case "connect":
            return syncEngine.respond(() => syncEngine.connect());
          case "enable":
            return syncEngine.respond(() => syncEngine.enable());
          case "disable":
            return syncEngine.respond(() => syncEngine.disable());
          case "sync-now":
            return syncEngine.respond(() => syncEngine.syncNow());
          case "set-bookmarks-enabled":
            return syncEngine.respond(() =>
              syncEngine.setBookmarksEnabled(request.enabled),
            );
          case "set-history-enabled":
            return syncEngine.respond(() =>
              syncEngine.setHistoryEnabled(request.enabled),
            );
          case "disconnect":
            return syncEngine.respond(() => syncEngine.disconnect());
        }
      })();
      void response.then(sendResponse);
      return true;
    },
  );

  void syncEngine.startup().catch((error) => syncEngine.reportError(error));
});
