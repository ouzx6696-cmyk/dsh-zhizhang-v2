// Local draft vault protecting unsaved edits across slow saves, reloads, and tabs.

export interface LocalDraft {
  readonly body: string;
  readonly revisionId: string | null;
}

export interface EditorBaseline {
  readonly id: string;
  readonly revisionId: string | null;
  readonly body: string;
}

interface StoredLocalBackup extends LocalDraft {
  readonly owner?: string;
}

function stashKey(id: string): string {
  return `zhizhang:draft:${id}`;
}

export class DraftVault {
  private readonly cache = new Map<string, LocalDraft | null>();
  private readonly owner: string;
  private storageUnavailableFlag = false;
  private readonly onStorageUnavailable: () => void;

  constructor(onStorageUnavailable: () => void) {
    const words = new Uint32Array(2);
    crypto.getRandomValues(words);
    this.owner = Array.from(words).join("-");
    this.onStorageUnavailable = onStorageUnavailable;
  }

  get storageUnavailable(): boolean {
    return this.storageUnavailableFlag;
  }

  read(documentId: string): LocalDraft | null {
    if (this.cache.has(documentId)) return this.cache.get(documentId) ?? null;
    let draft: LocalDraft | null = null;
    try {
      let tabDraft: string | null = null;
      try {
        tabDraft = sessionStorage.getItem(stashKey(documentId));
      } catch {
        // Ignore private browsing sessionStorage restrictions.
      }
      const raw = tabDraft ?? localStorage.getItem(stashKey(documentId));
      if (raw) {
        const parsed = JSON.parse(raw) as StoredLocalBackup | null;
        if (parsed && typeof parsed.body === "string") {
          draft = { body: parsed.body, revisionId: typeof parsed.revisionId === "string" ? parsed.revisionId : null };
        }
      }
    } catch {
      draft = null;
    }
    this.cache.set(documentId, draft);
    return draft;
  }

  write(documentId: string, draft: LocalDraft | null): void {
    const previous = this.read(documentId);
    if (
      draft?.body === previous?.body &&
      draft?.revisionId === previous?.revisionId &&
      !this.storageUnavailableFlag
    ) {
      return;
    }
    this.cache.set(documentId, draft);
    const key = stashKey(documentId);
    let stored = false;
    try {
      if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
      stored = true;
    } catch {
      // Fall back to localStorage below.
    }
    try {
      if (draft) {
        const payload: StoredLocalBackup = { ...draft, owner: this.owner };
        localStorage.setItem(key, JSON.stringify(payload));
      } else {
        const backupRaw = localStorage.getItem(key);
        const backup = backupRaw ? (JSON.parse(backupRaw) as StoredLocalBackup | null) : null;
        if (
          backup?.owner === this.owner ||
          (previous && backup?.body === previous.body && backup.revisionId === previous.revisionId)
        ) {
          localStorage.removeItem(key);
        }
      }
      stored = true;
    } catch {
      // Storage quota or sandbox restrictions.
    }
    this.storageUnavailableFlag = !stored;
    if (!stored) this.onStorageUnavailable();
  }

  stashFromEditor(baseline: EditorBaseline | undefined, currentValue: string): void {
    if (!baseline) return;
    const existing = this.read(baseline.id);
    const baseRevision = existing ? existing.revisionId : baseline.revisionId;
    const isClean = baseRevision === baseline.revisionId && currentValue === baseline.body;
    this.write(baseline.id, isClean ? null : { body: currentValue, revisionId: baseRevision });
  }

  isDirty(baseline: EditorBaseline | undefined, currentValue: string): boolean {
    if (!baseline) return false;
    const draft = this.read(baseline.id);
    return currentValue !== baseline.body || Boolean(draft && draft.revisionId !== baseline.revisionId);
  }
}
