/**
 * Fine-grained dirty-key gate replacing repeated brute-force DOM rebuilds and
 * full-tree JSON serialization on every state poll.
 */
export function createRenderGate() {
  const keys = new Map<string, string>();

  function changed(slot: string, signature: string): boolean {
    if (keys.get(slot) === signature) return false;
    keys.set(slot, signature);
    return true;
  }

  function reset(prefix?: string): void {
    if (!prefix) {
      keys.clear();
      return;
    }
    for (const key of keys.keys()) {
      if (key.startsWith(prefix)) keys.delete(key);
    }
  }

  return { changed, reset };
}

export function formatCharCount(count: number): string {
  if (count >= 10_000) {
    return `${(count / 10_000).toFixed(1)} 万字`;
  }
  return `${count.toLocaleString("zh-Hans")} 字`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  label = "",
  className?: string,
): HTMLElementTagNameMap[K] {
  const entry = document.createElement(tag);
  if (label) entry.textContent = label;
  if (className) entry.className = className;
  return entry;
}
