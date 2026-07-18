import { getAccessToken } from "./auth";
import {
  OPERATION_FILE_PREFIX,
  SCHEMA_VERSION,
  type OperationBatch,
  type SyncOperation,
} from "./model";

const API_ROOT = "https://www.googleapis.com/drive/v3";
const UPLOAD_ROOT = "https://www.googleapis.com/upload/drive/v3";

interface DriveFile {
  id: string;
  name: string;
}

interface FileListResponse {
  nextPageToken?: string;
  files?: DriveFile[];
}

interface ChangeListResponse {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: Array<{
    fileId: string;
    removed?: boolean;
    file?: DriveFile;
  }>;
}

async function driveFetch(
  input: string,
  init: RequestInit = {},
  retry = true,
): Promise<Response> {
  const token = await getAccessToken(false);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });

  if (response.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return driveFetch(input, init, false);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive request failed (${response.status}): ${body}`);
  }
  return response;
}

export async function createOperationFile(
  deviceId: string,
  operations: SyncOperation[],
): Promise<DriveFile> {
  const batch: OperationBatch = {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    createdAt: new Date().toISOString(),
    operations,
  };
  const name = `${OPERATION_FILE_PREFIX}${deviceId}-${Date.now()}-${crypto.randomUUID()}.json`;
  const boundary = `tabsync-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: ["appDataFolder"] });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(batch),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await driveFetch(
    `${UPLOAD_ROOT}/files?uploadType=multipart&fields=id,name`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  return response.json() as Promise<DriveFile>;
}

export async function listAllOperationFiles(): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name contains '${OPERATION_FILE_PREFIX}' and trashed = false`,
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const result = (await (
      await driveFetch(`${API_ROOT}/files?${query}`)
    ).json()) as FileListResponse;
    files.push(...(result.files ?? []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

export async function getStartPageToken(): Promise<string> {
  const result = (await (
    await driveFetch(`${API_ROOT}/changes/startPageToken`)
  ).json()) as { startPageToken?: string };
  if (!result.startPageToken) throw new Error("Drive did not return a change token");
  return result.startPageToken;
}

export async function listChangedOperationFiles(
  initialToken: string,
): Promise<{ files: DriveFile[]; nextToken: string }> {
  const files: DriveFile[] = [];
  let pageToken = initialToken;
  let nextToken = initialToken;

  do {
    const query = new URLSearchParams({
      pageToken,
      spaces: "appDataFolder",
      pageSize: "1000",
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name))",
    });
    const result = (await (
      await driveFetch(`${API_ROOT}/changes?${query}`)
    ).json()) as ChangeListResponse;

    for (const change of result.changes ?? []) {
      if (
        !change.removed &&
        change.file?.name.startsWith(OPERATION_FILE_PREFIX)
      ) {
        files.push(change.file);
      }
    }

    if (result.nextPageToken) {
      pageToken = result.nextPageToken;
    } else {
      nextToken = result.newStartPageToken ?? pageToken;
      break;
    }
  } while (true);

  return { files, nextToken };
}

export async function downloadOperationBatch(fileId: string): Promise<OperationBatch> {
  const response = await driveFetch(`${API_ROOT}/files/${fileId}?alt=media`);
  const batch = (await response.json()) as OperationBatch;
  if (batch.schemaVersion !== SCHEMA_VERSION || !Array.isArray(batch.operations)) {
    throw new Error(`Unsupported TabSync operation file: ${fileId}`);
  }
  return batch;
}
