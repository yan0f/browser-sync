import { defineConfig } from "wxt";

const driveScope = "https://www.googleapis.com/auth/drive.appdata";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "TabSync",
    description: "Mirror open tabs between Chromium browsers through Google Drive.",
    permissions: ["tabs", "identity", "storage", "alarms"],
    host_permissions: ["https://www.googleapis.com/*"],
    oauth2: {
      client_id:
        process.env.WXT_GOOGLE_CLIENT_ID ??
        "000000000000-configure-tabsync.apps.googleusercontent.com",
      scopes: [driveScope],
    },
    action: {
      default_title: "TabSync",
    },
    ...(process.env.WXT_EXTENSION_PUBLIC_KEY
      ? { key: process.env.WXT_EXTENSION_PUBLIC_KEY }
      : {}),
  },
});
