import type { RuntimeRequest, RuntimeResponse, SyncStatus } from "../../lib/model";
import "./style.css";

const summary = document.querySelector<HTMLParagraphElement>("#summary")!;
const details = document.querySelector<HTMLElement>("#details")!;
const tabCount = document.querySelector<HTMLElement>("#tab-count")!;
const bookmarkCount = document.querySelector<HTMLElement>("#bookmark-count")!;
const lastSync = document.querySelector<HTMLElement>("#last-sync")!;
const warning = document.querySelector<HTMLParagraphElement>("#warning")!;
const errorBox = document.querySelector<HTMLParagraphElement>("#error")!;
const actions = document.querySelector<HTMLDivElement>("#actions")!;

const REQUEST_TIMEOUTS: Record<RuntimeRequest["type"], number> = {
  status: 5_000,
  connect: 120_000,
  enable: 60_000,
  "sync-now": 60_000,
  "set-bookmarks-enabled": 60_000,
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

function bookmarkToggle(status: SyncStatus): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "toggle-row";

  const text = document.createElement("span");
  text.textContent = "Синхронизировать все закладки";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = status.bookmarksEnabled;
  input.addEventListener("change", async () => {
    setBusy(true);
    input.disabled = true;
    try {
      const response = await request({
        type: "set-bookmarks-enabled",
        enabled: input.checked,
      });
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
  errorBox.textContent = `${message}. Откройте chrome://extensions → TabSync → Ошибки для подробностей.`;
  errorBox.hidden = false;
  details.hidden = true;
  actions.replaceChildren(button("Повторить", "status"));
}

function setBusy(busy: boolean): void {
  for (const element of actions.querySelectorAll("button")) {
    (element as HTMLButtonElement).disabled = busy;
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
  actions.append(bookmarkToggle(status));
  actions.append(
    button("Синхронизировать сейчас", "sync-now"),
    button("Приостановить", "disable", true),
  );
}

void request({ type: "status" })
  .then((response) => render(response.status, response.ok ? undefined : response.error))
  .catch(renderFatal);
