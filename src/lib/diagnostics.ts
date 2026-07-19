export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticEntry {
  timestamp: string;
  level: DiagnosticLevel;
  event: string;
  details?: Record<string, unknown>;
}

const STORAGE_KEY = "diagnosticLogs";
const MAX_ENTRIES = 300;

let persistenceQueue: Promise<void> = Promise.resolve();

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && chrome.storage?.local !== undefined;
}

function consoleMethod(level: DiagnosticLevel): "debug" | "info" | "warn" | "error" {
  return level;
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

export function logDiagnostic(
  level: DiagnosticLevel,
  event: string,
  details?: Record<string, unknown>,
): void {
  const entry: DiagnosticEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };

  console[consoleMethod(level)](`[BrowserSync] ${event}`, details ?? "");
  if (!hasExtensionStorage()) return;

  persistenceQueue = persistenceQueue
    .then(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const existing = Array.isArray(stored[STORAGE_KEY])
        ? (stored[STORAGE_KEY] as DiagnosticEntry[])
        : [];
      await chrome.storage.local.set({
        [STORAGE_KEY]: [...existing, entry].slice(-MAX_ENTRIES),
      });
    })
    .catch((error) => {
      console.warn("[BrowserSync] diagnostics.persist_failed", error);
    });
}

export function logInfo(
  event: string,
  details?: Record<string, unknown>,
): void {
  logDiagnostic("info", event, details);
}

export function logWarn(
  event: string,
  details?: Record<string, unknown>,
): void {
  logDiagnostic("warn", event, details);
}

export function logError(event: string, error: unknown): void {
  logDiagnostic("error", event, errorDetails(error));
}

export async function getDiagnosticLogs(): Promise<DiagnosticEntry[]> {
  await persistenceQueue;
  if (!hasExtensionStorage()) return [];
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY])
    ? (stored[STORAGE_KEY] as DiagnosticEntry[])
    : [];
}

export async function clearDiagnosticLogs(): Promise<void> {
  await persistenceQueue;
  if (hasExtensionStorage()) await chrome.storage.local.remove(STORAGE_KEY);
}

export async function createDiagnosticReport(): Promise<string> {
  const logs = await getDiagnosticLogs();
  const manifest =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest()
      : undefined;
  const userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent : "unavailable";
  const lines = [
    `BrowserSync ${manifest?.version ?? "unknown"}`,
    `Generated: ${new Date().toISOString()}`,
    `User agent: ${userAgent}`,
    `Entries: ${logs.length}`,
    "",
    ...logs.map((entry) => JSON.stringify(entry)),
  ];
  return lines.join("\n");
}
