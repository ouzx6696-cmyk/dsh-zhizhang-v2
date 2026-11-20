export interface VirtualListOptions<T> {
  readonly rowHeight: number;
  readonly overscan?: number;
  readonly directThreshold?: number;
  readonly emptyText?: string;
  readonly renderItem: (item: T, index: number) => HTMLElement;
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

  const spacer = document.createElement("div");
  spacer.className = "vlist-spacer";
  const viewport = document.createElement("div");
  viewport.className = "vlist-window";
  spacer.append(viewport);

  function renderWindow(): void {
    rafPending = false;
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
        fragment.append(options.renderItem(items[i], i));
      }
      container.replaceChildren(fragment);
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
    const rangeKey = `${items.length}:${start}:${end}`;
    if (rangeKey === lastRange) return;
    lastRange = rangeKey;

    viewport.style.transform = `translateY(${start * rowHeight}px)`;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      fragment.append(options.renderItem(items[i], i));
    }
    viewport.replaceChildren(fragment);
  }

  const onScroll = () => {
    if (items.length <= directThreshold || rafPending) return;
    rafPending = true;
    requestAnimationFrame(renderWindow);
  };

  container.addEventListener("scroll", onScroll, { passive: true });

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
    scrollToIndex(index: number): void {
      if (items.length <= directThreshold || index < 0) return;
      container.scrollTop = Math.max(0, index * rowHeight - (container.clientHeight || 360) / 3);
      lastRange = "";
      renderWindow();
    },
    destroy(): void {
      container.removeEventListener("scroll", onScroll);
    },
  };
}
