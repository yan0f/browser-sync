import type { RuntimeRequest, RuntimeResponse, SyncStatus } from "../../lib/model";
import {
  clearDiagnosticLogs,
  createDiagnosticReport,
} from "../../lib/diagnostics";
import "./style.css";

const summary = document.querySelector<HTMLParagraphElement>("#summary")!;
const details = document.querySelector<HTMLElement>("#details")!;
const tabCount = document.querySelector<HTMLElement>("#tab-count")!;
const bookmarkCount = document.querySelector<HTMLElement>("#bookmark-count")!;
const historyCount = document.querySelector<HTMLElement>("#history-count")!;
const lastSync = document.querySelector<HTMLElement>("#last-sync")!;
const warning = document.querySelector<HTMLParagraphElement>("#warning")!;
const errorBox = document.querySelector<HTMLParagraphElement>("#error")!;
const actions = document.querySelector<HTMLDivElement>("#actions")!;
const copyLog = document.querySelector<HTMLButtonElement>("#copy-log")!;
const clearLog = document.querySelector<HTMLButtonElement>("#clear-log")!;
const diagnosticStatus =
  document.querySelector<HTMLParagraphElement>("#diagnostic-status")!;

const REQUEST_TIMEOUTS: Record<RuntimeRequest["type"], number> = {
  status: 5_000,
  connect: 120_000,
  enable: 60_000,
  "sync-now": 60_000,
  "set-bookmarks-enabled": 60_000,
  "set-history-enabled": 60_000,
  disable: 10_000,
  disconnect: 15_000,
};

async function request(request: RuntimeRequest): Promise<RuntimeResponse> {
  const timeoutMs = REQUEST_TIMEOUTS[request.type];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `Операция «${request.type}» не завершилась за ${Math.round(timeoutMs / 1_000)} секунд`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(request),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function button(label: string, type: RuntimeRequest["type"], secondary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  if (secondary) element.classList.add("secondary");
  element.addEventListener("click", async () => {
    setBusy(true);
    try {
      const response = await request({ type } as RuntimeRequest);
      render(response.status, response.ok ? undefined : response.error);
    } catch (error) {
      renderFatal(error);
    } finally {
      setBusy(false);
    }
  });
  return element;
}

function settingToggle(
  labelText: string,
  checked: boolean,
  requestFor: (enabled: boolean) => RuntimeRequest,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "toggle-row";

  const text = document.createElement("span");
  text.textContent = labelText;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", async () => {
    setBusy(true);
    input.disabled = true;
    try {
      const response = await request(requestFor(input.checked));
      render(response.status, response.ok ? undefined : response.error);
    } catch (error) {
      renderFatal(error);
    } finally {
      input.disabled = false;
      setBusy(false);
    }
  });
  label.append(text, input);
  return label;
}

function renderFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  summary.textContent = "Ошибка запуска";
  errorBox.textContent = `${message}. Откройте chrome://extensions → BrowserSync → Ошибки для подробностей.`;
  errorBox.hidden = false;
  details.hidden = true;
  actions.replaceChildren(button("Повторить", "status"));
}

function setBusy(busy: boolean): void {
  for (const element of actions.querySelectorAll("button, input")) {
    (element as HTMLButtonElement | HTMLInputElement).disabled = busy;
  }
  if (busy) summary.textContent = "Выполняется…";
}

function render(status: SyncStatus, explicitError?: string): void {
  actions.replaceChildren();
  errorBox.hidden = true;
  warning.hidden = true;
  details.hidden = !status.connected;

  tabCount.textContent = String(status.tabCount);
  bookmarkCount.textContent = String(status.bookmarkCount);
  historyCount.textContent = status.historyEnabled ? String(status.historyCount) : "—";
  lastSync.textContent = status.lastSyncAt
    ? new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(
        status.lastSyncAt,
      )
    : "—";

  const error = explicitError ?? status.error;
  if (error) {
    errorBox.textContent = error;
    errorBox.hidden = false;
  }

  if (!status.connected) {
    summary.textContent = "Google Drive не подключён";
    actions.append(button("Войти через Google", "connect"));
    return;
  }

  if (!status.enabled) {
    summary.textContent = "Готово к подключению";
    warning.textContent =
      "Если в облаке уже есть набор вкладок, локальные HTTP/HTTPS-вкладки будут заменены им.";
    warning.hidden = false;
    actions.append(
      button("Включить синхронизацию", "enable"),
      button("Отключить Google Drive", "disconnect", true),
    );
    return;
  }

  summary.textContent = status.syncing ? "Синхронизация…" : "Синхронизация включена";
  actions.append(
    settingToggle(
      "Синхронизировать все закладки",
      status.bookmarksEnabled,
      (enabled) => ({ type: "set-bookmarks-enabled", enabled }),
    ),
    settingToggle(
      "Синхронизировать новые посещения",
      status.historyEnabled,
      (enabled) => ({ type: "set-history-enabled", enabled }),
    ),
  );
  actions.append(
    button("Синхронизировать сейчас", "sync-now"),
    button("Приостановить", "disable", true),
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Браузер запретил доступ к буферу обмена");
  }
}

copyLog.addEventListener("click", async () => {
  copyLog.disabled = true;
  diagnosticStatus.textContent = "Подготовка журнала…";
  try {
    await copyText(await createDiagnosticReport());
    diagnosticStatus.textContent = "Журнал скопирован";
  } catch (error) {
    diagnosticStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    copyLog.disabled = false;
  }
});

clearLog.addEventListener("click", async () => {
  clearLog.disabled = true;
  try {
    await clearDiagnosticLogs();
    diagnosticStatus.textContent = "Журнал очищен";
  } catch (error) {
    diagnosticStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    clearLog.disabled = false;
  }
});

void request({ type: "status" })
  .then((response) => render(response.status, response.ok ? undefined : response.error))
  .catch(renderFatal);
