export interface DraftEntry {
  readonly body: string;
  readonly revisionId: string | null;
}

export interface EditorBase {
  readonly id: string;
  readonly revisionId: string | null;
  readonly body: string;
}

interface StoredDraft extends DraftEntry {
  readonly owner?: string;
}

const MAX_VAULT_CACHE = 256;

/**
 * Manages browser-local unsaved draft persistence (`sessionStorage` + owner-scoped
 * `localStorage`) so slow saves, page reloads, and multi-tab edits never lose text.
 */
export function createDraftVault(onStorageWarning: (message: string) => void) {
  const cache = new Map<string, DraftEntry | null>();
  const owner = Array.from(crypto.getRandomValues(new Uint32Array(2))).join("-");
  let storageUnavailable = false;

  const keyFor = (id: string) => `zhizhang:draft:${id}`;

  function cacheSet(id: string, entry: DraftEntry | null): void {
    cache.delete(id);
    cache.set(id, entry);
    if (cache.size > MAX_VAULT_CACHE) {
      cache.delete(cache.keys().next().value!);
    }
  }

  function read(id: string): DraftEntry | null {
    if (cache.has(id)) return cache.get(id) ?? null;
    let draft: DraftEntry | null = null;
    try {
      let tabRaw: string | null = null;
      try {
        tabRaw = sessionStorage.getItem(keyFor(id));
      } catch {
        // Ignore private-mode storage errors.
      }
      const parsed = JSON.parse(tabRaw ?? localStorage.getItem(keyFor(id)) ?? "null") as StoredDraft | null;
      if (parsed && typeof parsed.body === "string") {
        draft = { body: parsed.body, revisionId: parsed.revisionId ?? null };
      }
    } catch {
      draft = null;
    }
    cacheSet(id, draft);
    return draft;
  }

  function write(id: string, draft: DraftEntry | null): void {
    const previous = read(id);
    if (draft?.body === previous?.body && draft?.revisionId === previous?.revisionId && !storageUnavailable) {
      return;
    }
    cacheSet(id, draft);
    const key = keyFor(id);
    let stored = false;
    try {
      if (draft) {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } else {
        sessionStorage.removeItem(key);
      }
      stored = true;
    } catch {
      // Fall through to localStorage.
    }
    try {
      if (draft) {
        localStorage.setItem(key, JSON.stringify({ ...draft, owner }));
      } else {
        const backup = JSON.parse(localStorage.getItem(key) ?? "null") as StoredDraft | null;
        if (
          backup?.owner === owner ||
          (previous && backup?.body === previous.body && backup.revisionId === previous.revisionId)
        ) {
          localStorage.removeItem(key);
        }
      }
      stored = true;
    } catch {
      // Handled via storageUnavailable notice below.
    }
    storageUnavailable = !stored;
    if (!stored) {
      onStorageWarning("浏览器暂时无法保留本地草稿。请保存正文后再离开。");
    }
  }

  function capture(base: EditorBase | undefined, currentValue: string): void {
    if (!base) return;
    const existing = read(base.id);
    const baseRev = existing ? existing.revisionId : base.revisionId;
    const isClean = baseRev === base.revisionId && currentValue === base.body;
    write(base.id, isClean ? null : { body: currentValue, revisionId: baseRev });
  }

  function isDirty(base: EditorBase | undefined, currentValue: string): boolean {
    if (!base) return false;
    const existing = read(base.id);
    return currentValue !== base.body || Boolean(existing && existing.revisionId !== base.revisionId);
  }

  function isUnavailable(): boolean {
    return storageUnavailable;
  }

  return { read, write, capture, isDirty, isUnavailable };
}

export type DraftVault = ReturnType<typeof createDraftVault>;
