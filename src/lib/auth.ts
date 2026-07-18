export const DRIVE_APPDATA_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata";

export async function getAccessToken(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({
    interactive,
    scopes: [DRIVE_APPDATA_SCOPE],
  });
  const token = typeof result === "string" ? result : result.token;
  if (!token) throw new Error("Google did not return an access token");
  return token;
}

export async function isConnected(): Promise<boolean> {
  try {
    await getAccessToken(false);
    return true;
  } catch {
    return false;
  }
}

export async function forgetAccessToken(): Promise<void> {
  await chrome.identity.clearAllCachedAuthTokens();
}
