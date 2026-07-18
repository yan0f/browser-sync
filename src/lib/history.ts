import { isSupportedUrl } from "./tabs";

const MAX_HISTORY_RESULTS = 100_000;

export async function queryHistoryUrls(): Promise<Set<string>> {
  const entries = await chrome.history.search({
    text: "",
    startTime: 0,
    maxResults: MAX_HISTORY_RESULTS,
  });
  return new Set(entries.flatMap((entry) => (isSupportedUrl(entry.url) ? [entry.url] : [])));
}

async function inChunks<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  const chunkSize = 50;
  for (let index = 0; index < items.length; index += chunkSize) {
    await Promise.all(items.slice(index, index + chunkSize).map(action));
  }
}

export async function reconcileHistory(
  desiredUrls: string[],
  removedUrls: string[],
): Promise<void> {
  const current = await queryHistoryUrls();
  const added = desiredUrls.filter((url) => !current.has(url));
  const removed = removedUrls.filter((url) => current.has(url));

  await inChunks(added, (url) => chrome.history.addUrl({ url }));
  await inChunks(removed, (url) => chrome.history.deleteUrl({ url }));
}
