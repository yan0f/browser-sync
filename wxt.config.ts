import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "wxt";

const driveScope = "https://www.googleapis.com/auth/drive.appdata";
const fileEnv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const googleClientId =
  process.env.WXT_GOOGLE_CLIENT_ID ?? fileEnv.WXT_GOOGLE_CLIENT_ID;
const extensionPublicKey =
  process.env.WXT_EXTENSION_PUBLIC_KEY ?? fileEnv.WXT_EXTENSION_PUBLIC_KEY;

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "TabSync",
    description: "Synchronize tabs, bookmarks and history through Google Drive.",
    permissions: ["tabs", "bookmarks", "history", "identity", "storage", "alarms"],
    host_permissions: ["https://www.googleapis.com/*"],
    oauth2: {
      client_id:
        googleClientId ??
        "000000000000-configure-tabsync.apps.googleusercontent.com",
      scopes: [driveScope],
    },
    action: {
      default_title: "TabSync",
    },
    ...(extensionPublicKey ? { key: extensionPublicKey } : {}),
  },
});
