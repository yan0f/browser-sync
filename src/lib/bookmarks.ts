import type { BookmarkSnapshot, SyncedBookmark } from "./model";

function serializeNode(node: chrome.bookmarks.BookmarkTreeNode): SyncedBookmark {
  if (node.url !== undefined) return { title: node.title, url: node.url };
  return {
    title: node.title,
    children: (node.children ?? []).map(serializeNode),
  };
}

export async function captureBookmarks(): Promise<BookmarkSnapshot> {
  const tree = await chrome.bookmarks.getTree();
  return {
    roots: (tree[0]?.children ?? []).map((root) =>
      (root.children ?? []).map(serializeNode),
    ),
  };
}

export function bookmarkCount(snapshot: BookmarkSnapshot): number {
  const count = (nodes: SyncedBookmark[]): number =>
    nodes.reduce(
      (total, node) => total + (node.url === undefined ? count(node.children ?? []) : 1),
      0,
    );
  return snapshot.roots.reduce((total, root) => total + count(root), 0);
}

export function sameBookmarkSnapshot(
  left: BookmarkSnapshot,
  right: BookmarkSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFolder(node: chrome.bookmarks.BookmarkTreeNode | SyncedBookmark): boolean {
  return node.url === undefined;
}

async function reconcileChildren(
  parentId: string,
  current: chrome.bookmarks.BookmarkTreeNode[],
  desired: SyncedBookmark[],
): Promise<void> {
  const unused = [...current];

  for (const [index, wanted] of desired.entries()) {
    let matchIndex = unused.findIndex(
      (node) =>
        isFolder(node) === isFolder(wanted) &&
        node.title === wanted.title &&
        (isFolder(node) || node.url === wanted.url),
    );
    if (matchIndex < 0) {
      matchIndex = unused.findIndex((node) => isFolder(node) === isFolder(wanted));
    }

    let node = matchIndex >= 0 ? unused.splice(matchIndex, 1)[0] : undefined;
    if (!node) {
      node = await chrome.bookmarks.create({
        parentId,
        index,
        title: wanted.title,
        ...(wanted.url === undefined ? {} : { url: wanted.url }),
      });
    } else {
      const changes: { title?: string; url?: string } = {};
      if (node.title !== wanted.title) changes.title = wanted.title;
      if (wanted.url !== undefined && node.url !== wanted.url) changes.url = wanted.url;
      if (Object.keys(changes).length > 0) {
        node = await chrome.bookmarks.update(node.id, changes);
      }
      if (node.parentId !== parentId || node.index !== index) {
        node = await chrome.bookmarks.move(node.id, { parentId, index });
      }
    }

    if (wanted.url === undefined) {
      const [fresh] = await chrome.bookmarks.getSubTree(node.id);
      await reconcileChildren(node.id, fresh?.children ?? [], wanted.children ?? []);
    }
  }

  for (const extra of unused) {
    if (isFolder(extra)) await chrome.bookmarks.removeTree(extra.id);
    else await chrome.bookmarks.remove(extra.id);
  }
}

export async function reconcileBookmarks(snapshot: BookmarkSnapshot): Promise<void> {
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children ?? [];
  for (let index = 0; index < Math.min(roots.length, snapshot.roots.length); index += 1) {
    await reconcileChildren(roots[index]!.id, roots[index]!.children ?? [], snapshot.roots[index]!);
  }
}
