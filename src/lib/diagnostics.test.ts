import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDiagnosticLogs,
  createDiagnosticReport,
  getDiagnosticLogs,
  logInfo,
} from "./diagnostics";

describe("diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists structured entries and creates a copyable report", async () => {
    const storage: Record<string, unknown> = {};
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storage[key] }),
          set: async (values: Record<string, unknown>) => Object.assign(storage, values),
          remove: async (key: string) => {
            delete storage[key];
          },
        },
      },
      runtime: {
        getManifest: () => ({ version: "0.2.4" }),
      },
    });

    logInfo("sync.completed", { durationMs: 42 });

    expect(await getDiagnosticLogs()).toEqual([
      expect.objectContaining({
        level: "info",
        event: "sync.completed",
        details: { durationMs: 42 },
      }),
    ]);
    expect(await createDiagnosticReport()).toContain('"event":"sync.completed"');

    await clearDiagnosticLogs();
    expect(await getDiagnosticLogs()).toEqual([]);
  });
});
