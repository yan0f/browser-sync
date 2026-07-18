import { defineBackground } from "wxt/utils/define-background";
import type { RuntimeRequest, RuntimeResponse } from "../lib/model";
import { SYNC_ALARM, syncEngine } from "../lib/sync-engine";

export default defineBackground(() => {
  const noteLocalChange = () => syncEngine.noteLocalChange();

  chrome.tabs.onCreated.addListener(noteLocalChange);
  chrome.tabs.onRemoved.addListener(noteLocalChange);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url !== undefined || changeInfo.pinned !== undefined) {
      noteLocalChange();
    }
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void syncEngine.syncNow().catch(() => undefined);
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
