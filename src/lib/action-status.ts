export interface ToolbarStatus {
  connected: boolean;
  enabled: boolean;
  syncing: boolean;
  error?: string;
}

export interface ToolbarPresentation {
  badge: string;
  title: string;
}

const BADGE_BACKGROUND = "#5f6368";
const BADGE_TEXT = "#ffffff";

export function getToolbarPresentation(status: ToolbarStatus): ToolbarPresentation {
  if (status.syncing) {
    return { badge: "…", title: "BrowserSync — синхронизация…" };
  }
  if (status.error) {
    return { badge: "!", title: "BrowserSync — ошибка синхронизации" };
  }
  if (!status.connected) {
    return { badge: "", title: "BrowserSync — Google Drive не подключён" };
  }
  if (!status.enabled) {
    return { badge: "", title: "BrowserSync — синхронизация приостановлена" };
  }
  return { badge: "", title: "BrowserSync — синхронизировано" };
}

export async function updateToolbarStatus(status: ToolbarStatus): Promise<void> {
  try {
    const presentation = getToolbarPresentation(status);
    const updates: Promise<void>[] = [
      chrome.action.setBadgeText({ text: presentation.badge }),
      chrome.action.setTitle({ title: presentation.title }),
    ];

    if (presentation.badge) {
      updates.push(
        chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND }),
      );
      if (typeof chrome.action.setBadgeTextColor === "function") {
        updates.push(chrome.action.setBadgeTextColor({ color: BADGE_TEXT }));
      }
    }

    const results = await Promise.allSettled(updates);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) console.warn("Не удалось обновить статус BrowserSync", failure.reason);
  } catch (error) {
    console.warn("Не удалось обновить статус BrowserSync", error);
  }
}
