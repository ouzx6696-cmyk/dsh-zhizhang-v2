export interface VirtualListOptions<T> {
  readonly rowHeight: number;
  readonly overscan?: number;
  readonly directThreshold?: number;
  readonly emptyText?: string;
  readonly getKey?: (item: T, index: number) => string;
  readonly renderItem: (item: T, index: number) => HTMLElement;
}

function isDescendantOf(container: HTMLElement, node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (node === container) return true;
  if (typeof container.contains === "function") {
    try {
      return container.contains(node as Node);
    } catch {
      // Fall back to parentElement walk for fake DOM tests.
    }
  }
  let cur = (node as { parentElement?: HTMLElement | null }).parentElement ?? null;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentElement ?? null;
  }
  return false;
}

/**
 * Lightweight zero-dependency virtual list that renders direct nodes for small
 * lists (<= 80 items) and switches smoothly to fixed-height windowed DOM
 * slicing for 650–5000+ chapter manuscripts.
 */
export function createVirtualList<T>(container: HTMLElement, options: VirtualListOptions<T>) {
  const rowHeight = options.rowHeight;
  const overscan = options.overscan ?? 6;
  const directThreshold = options.directThreshold ?? 80;
  let items: readonly T[] = [];
  let rafPending = false;
  let lastRange = "";
  let focusedKey: string | null = null;
  let restoreFocusOnNextRender = false;

  if (typeof container.style?.setProperty === "function") {
    container.style.setProperty("--vrow-h", `${rowHeight}px`);
  }

  const spacer = document.createElement("div");
  spacer.className = "vlist-spacer";
  const viewport = document.createElement("div");
  viewport.className = "vlist-window";
  spacer.append(viewport);

  function readFocusedKeyFromDom(): { key: string | null; activeInside: boolean } {
    if (typeof document === "undefined") return { key: null, activeInside: false };
    const active = (document as { activeElement?: HTMLElement | null }).activeElement ?? null;
    if (!active || !isDescendantOf(container, active)) {
      return { key: null, activeInside: false };
    }
    const key = active.dataset?.vlistKey ?? null;
    return { key, activeInside: true };
  }

  function renderNode(item: T, index: number): HTMLElement {
    const node = options.renderItem(item, index);
    if (options.getKey && node.dataset) {
      node.dataset.vlistKey = options.getKey(item, index);
    }
    return node;
  }

  function restoreFocusIn(root: HTMLElement, targetKey: string | null): void {
    if (!targetKey) return;
    const children = root.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      if (child.dataset?.vlistKey === targetKey) {
        child.focus?.({ preventScroll: true });
        return;
      }
    }
  }

  function renderWindow(): void {
    rafPending = false;
    const domFocus = readFocusedKeyFromDom();
    if (domFocus.key) focusedKey = domFocus.key;
    const shouldRestoreFocus = restoreFocusOnNextRender || domFocus.activeInside;
    restoreFocusOnNextRender = false;

    if (items.length === 0) {
      lastRange = "empty";
      const empty = document.createElement("p");
      empty.className = "muted-copy";
      empty.textContent = options.emptyText ?? "暂无记录。";
      container.replaceChildren(empty);
      return;
    }

    if (items.length <= directThreshold) {
      lastRange = `direct:${items.length}`;
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < items.length; i++) {
        fragment.append(renderNode(items[i], i));
      }
      container.replaceChildren(fragment);
      if (shouldRestoreFocus) restoreFocusIn(container, focusedKey);
      return;
    }

    const totalHeight = items.length * rowHeight;
    spacer.style.height = `${totalHeight}px`;
    if (spacer.parentElement !== container) {
      container.replaceChildren(spacer);
    }
    const scrollTop = container.scrollTop;
    const viewHeight = container.clientHeight || 480;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewHeight / rowHeight) + overscan * 2;
    const end = Math.min(items.length, start + visibleCount);
    const rangeKey = `${items.length}:${start}:${end}:${viewHeight}`;
    if (rangeKey === lastRange) {
      if (shouldRestoreFocus) restoreFocusIn(viewport, focusedKey);
      return;
    }
    lastRange = rangeKey;

    viewport.style.transform = `translateY(${start * rowHeight}px)`;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      fragment.append(renderNode(items[i], i));
    }
    viewport.replaceChildren(fragment);
    if (shouldRestoreFocus) restoreFocusIn(viewport, focusedKey);
  }

  const scheduleRender = () => {
    if (rafPending) return;
    rafPending = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(renderWindow);
    } else {
      renderWindow();
    }
  };

  const onScroll = () => {
    if (items.length <= directThreshold || rafPending) return;
    scheduleRender();
  };

  container.addEventListener("scroll", onScroll, { passive: true });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    try {
      resizeObserver = new ResizeObserver(() => {
        if (items.length <= directThreshold) return;
        lastRange = "";
        scheduleRender();
      });
      resizeObserver.observe(container);
    } catch {
      resizeObserver = null;
    }
  }

  return {
    setItems(nextItems: readonly T[]): void {
      items = nextItems;
      lastRange = "";
      renderWindow();
    },
    refresh(): void {
      lastRange = "";
      renderWindow();
    },
    setFocusedKey(key: string | null, focusNow = false): void {
      focusedKey = key;
      if (!focusNow || !key) return;
      const root = items.length > directThreshold ? viewport : container;
      restoreFocusIn(root, key);
    },
    getFocusedKey(): string | null {
      return focusedKey;
    },
    scrollToIndex(index: number): void {
      if (items.length <= directThreshold || index < 0 || index >= items.length) return;
      container.scrollTop = Math.max(0, index * rowHeight - (container.clientHeight || 360) / 3);
      lastRange = "";
      renderWindow();
    },
    ensureVisible(index: number, focusKey?: string): void {
      if (index < 0 || index >= items.length) return;
      if (focusKey) {
        focusedKey = focusKey;
        restoreFocusOnNextRender = true;
      }
      if (items.length > directThreshold) {
        const viewHeight = container.clientHeight || 360;
        const itemTop = index * rowHeight;
        const itemBottom = itemTop + rowHeight;
        if (itemTop < container.scrollTop) {
          container.scrollTop = itemTop;
          lastRange = "";
        } else if (itemBottom > container.scrollTop + viewHeight) {
          container.scrollTop = Math.max(0, itemBottom - viewHeight);
          lastRange = "";
        }
      }
      renderWindow();
    },
    destroy(): void {
      container.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      resizeObserver = null;
    },
  };
}
