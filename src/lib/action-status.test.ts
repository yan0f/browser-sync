import { describe, expect, it } from "vitest";
import { getToolbarPresentation } from "./action-status";

describe("toolbar status", () => {
  it("shows a monochrome progress badge while syncing", () => {
    expect(
      getToolbarPresentation({ connected: true, enabled: true, syncing: true }),
    ).toEqual({ badge: "…", title: "BrowserSync — синхронизация…" });
  });

  it("shows an error badge after a failed operation", () => {
    expect(
      getToolbarPresentation({
        connected: true,
        enabled: true,
        syncing: false,
        error: "Drive unavailable",
      }).badge,
    ).toBe("!");
  });

  it("keeps the toolbar clean in normal and paused states", () => {
    expect(
      getToolbarPresentation({ connected: true, enabled: true, syncing: false })
        .badge,
    ).toBe("");
    expect(
      getToolbarPresentation({ connected: true, enabled: false, syncing: false })
        .badge,
    ).toBe("");
  });
});
