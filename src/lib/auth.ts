export const DRIVE_APPDATA_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata";

const TOKEN_KEY = "googleOAuthToken";
const TOKEN_EXPIRY_KEY = "googleOAuthTokenExpiresAt";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

interface StoredToken {
  token?: unknown;
  expiresAt?: unknown;
}

function clientId(): string {
  const id = chrome.runtime.getManifest().oauth2?.client_id;
  if (!id || id.includes("configure-tabsync")) {
    throw new Error("Google OAuth client ID не настроен в .env");
  }
  return id;
}

async function storedToken(): Promise<StoredToken> {
  const values = await chrome.storage.local.get([TOKEN_KEY, TOKEN_EXPIRY_KEY]);
  return {
    token: values[TOKEN_KEY],
    expiresAt: values[TOKEN_EXPIRY_KEY],
  };
}

async function launchGoogleOAuth(interactive: boolean): Promise<string> {
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "token",
    scope: DRIVE_APPDATA_SCOPE,
    state,
    include_granted_scopes: "true",
    prompt: interactive ? "select_account" : "none",
  });

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: `${AUTH_ENDPOINT}?${query}`,
    interactive,
    ...(interactive
      ? {}
      : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 }),
  });
  if (!responseUrl) throw new Error("Google OAuth не вернул redirect URL");

  const result = new URL(responseUrl);
  const values = new URLSearchParams(result.hash.slice(1));
  const error = values.get("error") ?? result.searchParams.get("error");
  if (error) throw new Error(`Google OAuth: ${error}`);
  if (values.get("state") !== state) {
    throw new Error("Google OAuth вернул некорректный state");
  }

  const token = values.get("access_token");
  if (!token) throw new Error("Google OAuth не вернул access token");
  const expiresIn = Number(values.get("expires_in") ?? "3600");
  await chrome.storage.local.set({
    [TOKEN_KEY]: token,
    [TOKEN_EXPIRY_KEY]: Date.now() + expiresIn * 1_000,
  });
  return token;
}

export async function getAccessToken(interactive: boolean): Promise<string> {
  const { token, expiresAt } = await storedToken();
  if (
    typeof token === "string" &&
    typeof expiresAt === "number" &&
    expiresAt > Date.now() + 60_000
  ) {
    return token;
  }
  return launchGoogleOAuth(interactive);
}

export async function invalidateAccessToken(token: string): Promise<void> {
  const stored = await storedToken();
  if (stored.token === token) {
    await chrome.storage.local.remove([TOKEN_KEY, TOKEN_EXPIRY_KEY]);
  }
}

export async function forgetAccessToken(): Promise<void> {
  await chrome.storage.local.remove([TOKEN_KEY, TOKEN_EXPIRY_KEY]);
}
