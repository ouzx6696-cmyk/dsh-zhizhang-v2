import type {
  ActDto,
  ChapterTreeItemDto,
  DocumentSummary,
  NovelTreeDto,
  VolumeDto,
} from "../../../contracts/workspace-dto.ts";
import { el, formatCharCount } from "../store.ts";
import { createVirtualList } from "./virtual-list.ts";

const CHAPTER_STATE_LABELS: Readonly<Record<string, string>> = {
  planned: "待写",
  drafting: "草稿",
  drafted: "待审",
  reviewed: "已审",
  final: "定稿",
};

export type FlatTreeNode =
  | {
      readonly kind: "volume";
      readonly key: string;
      readonly level?: 1;
      readonly parentKey?: null;
      readonly volume: VolumeDto;
      readonly count: number;
      readonly chars: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "act";
      readonly key: string;
      readonly level?: 2;
      readonly parentKey?: string;
      readonly act: ActDto;
      readonly count: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "ungrouped";
      readonly key: string;
      readonly level?: 1;
      readonly parentKey?: null;
      readonly count: number;
    }
  | {
      readonly kind: "chapter";
      readonly key: string;
      readonly level?: 1 | 2 | 3;
      readonly parentKey?: string | null;
      readonly id: string;
      readonly title: string;
      readonly state?: string;
      readonly charCount?: number;
      readonly syncStatus?: "clean" | "dirty";
    };

export interface TreeSidebarOptions {
  readonly formatUntitled?: (doc: { readonly id: string; readonly title: string }) => string;
}

export interface TreeSidebarController {
  renderFlat(documents: readonly DocumentSummary[], activeId: string): void;
  renderNovelTree(tree: NovelTreeDto, activeId: string): void;
  updateActiveId(activeId: string): void;
  scrollToActive(): void;
  setFilter(query: string): void;
  destroy(): void;
}

/**
 * Flattens a 3-tier `Volume -> Act -> Chapter` novel tree in a single O(N) pass
 * so 5,000+ chapter books render identically through `createVirtualList` with
 * bounded viewport DOM nodes.
 */
export function flattenNovelTree(
  tree: NovelTreeDto,
  collapsedVolumes: ReadonlySet<string>,
  collapsedActs: ReadonlySet<string>,
  filterText: string,
): FlatTreeNode[] {
  const needle = filterText.trim().toLowerCase();
  const hasFilter = needle.length > 0;
  const matchedChapters = hasFilter
    ? tree.chapters.filter(
        (ch) => ch.title.toLowerCase().includes(needle) || ch.summary.toLowerCase().includes(needle),
      )
    : tree.chapters;

  if (tree.volumes.length === 0) {
    return matchedChapters.map((ch) => ({
      kind: "chapter" as const,
      key: `ch:${ch.id}`,
      level: 1 as const,
      parentKey: null,
      id: ch.id,
      title: ch.title,
      state: ch.state,
      charCount: ch.charCount,
      syncStatus: ch.syncStatus,
    }));
  }

  const byVolDirect = new Map<string, ChapterTreeItemDto[]>();
  const byAct = new Map<string, ChapterTreeItemDto[]>();
  const volCounts = new Map<string, number>();
  const volChars = new Map<string, number>();
  const ungrouped: ChapterTreeItemDto[] = [];

  for (const ch of matchedChapters) {
    if (!ch.volumeId) {
      ungrouped.push(ch);
      continue;
    }
    volCounts.set(ch.volumeId, (volCounts.get(ch.volumeId) ?? 0) + 1);
    volChars.set(ch.volumeId, (volChars.get(ch.volumeId) ?? 0) + ch.charCount);
    if (ch.actId) {
      const bucket = byAct.get(ch.actId);
      if (bucket) bucket.push(ch);
      else byAct.set(ch.actId, [ch]);
    } else {
      const bucket = byVolDirect.get(ch.volumeId);
      if (bucket) bucket.push(ch);
      else byVolDirect.set(ch.volumeId, [ch]);
    }
  }

  const actsByVolume = new Map<string, ActDto[]>();
  for (const act of tree.acts) {
    const bucket = actsByVolume.get(act.volumeId);
    if (bucket) bucket.push(act);
    else actsByVolume.set(act.volumeId, [act]);
  }

  const nodes: FlatTreeNode[] = [];
  for (const vol of tree.volumes) {
    const count = volCounts.get(vol.id) ?? 0;
    if (hasFilter && count === 0) continue;
    const isVolCollapsed = !hasFilter && collapsedVolumes.has(vol.id);
    const volKey = `vol:${vol.id}`;
    nodes.push({
      kind: "volume",
      key: volKey,
      level: 1,
      parentKey: null,
      volume: vol,
      count,
      chars: volChars.get(vol.id) ?? 0,
      collapsed: isVolCollapsed,
    });
    if (isVolCollapsed) continue;

    for (const act of actsByVolume.get(vol.id) ?? []) {
      const actChapters = byAct.get(act.id) ?? [];
      if (hasFilter && actChapters.length === 0) continue;
      const isActCollapsed = !hasFilter && collapsedActs.has(act.id);
      const actKey = `act:${act.id}`;
      nodes.push({
        kind: "act",
        key: actKey,
        level: 2,
        parentKey: volKey,
        act,
        count: actChapters.length,
        collapsed: isActCollapsed,
      });
      if (isActCollapsed) continue;
      for (const ch of actChapters) {
        nodes.push({
          kind: "chapter",
          key: `ch:${ch.id}`,
          level: 3,
          parentKey: actKey,
          id: ch.id,
          title: ch.title,
          state: ch.state,
          charCount: ch.charCount,
          syncStatus: ch.syncStatus,
        });
      }
    }

    for (const ch of byVolDirect.get(vol.id) ?? []) {
      nodes.push({
        kind: "chapter",
        key: `ch:${ch.id}`,
        level: 2,
        parentKey: volKey,
        id: ch.id,
        title: ch.title,
        state: ch.state,
        charCount: ch.charCount,
        syncStatus: ch.syncStatus,
      });
    }
  }

  if (ungrouped.length > 0) {
    nodes.push({ kind: "ungrouped", key: "vol:ungrouped", level: 1, parentKey: null, count: ungrouped.length });
    for (const ch of ungrouped) {
      nodes.push({
        kind: "chapter",
        key: `ch:${ch.id}`,
        level: 2,
        parentKey: null,
        id: ch.id,
        title: ch.title,
        state: ch.state,
        charCount: ch.charCount,
        syncStatus: ch.syncStatus,
      });
    }
  }

  return nodes;
}

export function createTreeSidebar(
  container: HTMLElement,
  onSelect: (documentId: string) => void,
  options?: TreeSidebarOptions,
): TreeSidebarController {
  let mode: "flat" | "tree" = "flat";
  let filterText = "";
  let currentActiveId = "";
  let lastFlatDocs: readonly DocumentSummary[] = [];
  let lastTree: NovelTreeDto | null = null;
  let visibleNodes: readonly FlatTreeNode[] = [];
  let focusedKey: string | null = null;
  const collapsedVolumes = new Set<string>();
  const collapsedActs = new Set<string>();

  container.setAttribute("role", "tree");

  function isFocusableNode(node: FlatTreeNode): boolean {
    return node.kind !== "ungrouped";
  }

  function resolveTabIndex(key: string): number {
    return focusedKey === key ? 0 : -1;
  }

  function renderFlatNode(node: FlatTreeNode): HTMLElement {
    const level = node.level ?? (node.kind === "act" ? 2 : 1);
    if (node.kind === "volume") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-toggle-row tree-vol-row";
      btn.dataset.volumeToggle = node.volume.id;
      btn.dataset.level = String(level);
      btn.setAttribute("role", "treeitem");
      btn.setAttribute("aria-level", String(level));
      btn.setAttribute("aria-expanded", String(!node.collapsed));
      btn.tabIndex = resolveTabIndex(node.key);
      btn.textContent = `${node.collapsed ? "▸" : "▾"} ${node.volume.title}（${node.count}章${node.chars > 0 ? ` · ${formatCharCount(node.chars)}` : ""}）`;
      return btn;
    }
    if (node.kind === "act") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-act-toggle tree-act-row";
      btn.dataset.actToggle = node.act.id;
      btn.dataset.level = String(level);
      btn.setAttribute("role", "treeitem");
      btn.setAttribute("aria-level", String(level));
      btn.setAttribute("aria-expanded", String(!node.collapsed));
      btn.tabIndex = resolveTabIndex(node.key);
      btn.textContent = `${node.collapsed ? "▸" : "▾"} ${node.act.title}（${node.count}）`;
      return btn;
    }
    if (node.kind === "ungrouped") {
      const header = el("div", `未分卷章节（${node.count}）`, "tree-ungrouped-label");
      header.setAttribute("role", "presentation");
      return header;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-nav-btn";
    button.dataset.docId = node.id;
    button.dataset.level = String(level);
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-level", String(level));
    const isActive = node.id === currentActiveId;
    button.setAttribute("aria-current", String(isActive));
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = resolveTabIndex(node.key);

    const badge = node.state ? (CHAPTER_STATE_LABELS[node.state] ?? node.state) : "";
    const chars = typeof node.charCount === "number" && node.charCount > 0 ? formatCharCount(node.charCount) : "";
    const syncTag = node.syncStatus === "dirty" ? "待同步" : "";
    const metaText = [badge, chars, syncTag].filter(Boolean).join(" · ");

    const displayTitle = node.title || options?.formatUntitled?.({ id: node.id, title: node.title }) || "未命名稿件";
    button.title = metaText ? `${displayTitle} · ${metaText}` : displayTitle;
    button.append(el("span", displayTitle, "doc-nav-title"));
    if (metaText) {
      button.append(el("span", metaText, "doc-nav-meta tabular"));
    }
    return button;
  }

  const virtualList = createVirtualList<FlatTreeNode>(container, {
    rowHeight: 48,
    overscan: 2,
    directThreshold: 40,
    emptyText: "暂无匹配章节或稿件，请先新建。",
    getKey: (node) => node.key,
    renderItem: renderFlatNode,
  });

  function syncRovingTabIndex(nextKey: string | null): void {
    focusedKey = nextKey;
    virtualList.setFocusedKey(nextKey);
    for (const item of container.querySelectorAll<HTMLElement>("[role=\"treeitem\"]")) {
      item.tabIndex = item.dataset.vlistKey === nextKey ? 0 : -1;
    }
  }

  function focusNodeAt(index: number): void {
    const node = visibleNodes[index];
    if (!node || !isFocusableNode(node)) return;
    syncRovingTabIndex(node.key);
    virtualList.ensureVisible(index, node.key);
    virtualList.setFocusedKey(node.key, true);
  }

  function findNextFocusable(startIdx: number, step: 1 | -1): number {
    for (let i = startIdx + step; i >= 0 && i < visibleNodes.length; i += step) {
      if (isFocusableNode(visibleNodes[i])) return i;
    }
    return -1;
  }

  function toggleNodeCollapse(node: FlatTreeNode, forceCollapsed?: boolean): boolean {
    if (node.kind === "volume") {
      const id = node.volume.id;
      const next = forceCollapsed ?? !collapsedVolumes.has(id);
      if (next === collapsedVolumes.has(id)) return false;
      if (next) collapsedVolumes.add(id);
      else collapsedVolumes.delete(id);
      return true;
    }
    if (node.kind === "act") {
      const id = node.act.id;
      const next = forceCollapsed ?? !collapsedActs.has(id);
      if (next === collapsedActs.has(id)) return false;
      if (next) collapsedActs.add(id);
      else collapsedActs.delete(id);
      return true;
    }
    return false;
  }

  const onClick = (event: Event) => {
    const rawTarget = event.target as HTMLElement | null;
    if (!rawTarget || typeof rawTarget.closest !== "function") return;
    const docBtn = rawTarget.closest<HTMLButtonElement>("button[data-doc-id]");
    if (docBtn?.dataset.docId) {
      if (docBtn.dataset.vlistKey) syncRovingTabIndex(docBtn.dataset.vlistKey);
      onSelect(docBtn.dataset.docId);
      return;
    }
    const volBtn = rawTarget.closest<HTMLButtonElement>("button[data-volume-toggle]");
    if (volBtn?.dataset.volumeToggle) {
      const id = volBtn.dataset.volumeToggle;
      focusedKey = `vol:${id}`;
      virtualList.setFocusedKey(focusedKey);
      if (collapsedVolumes.has(id)) collapsedVolumes.delete(id);
      else collapsedVolumes.add(id);
      repaint();
      return;
    }
    const actBtn = rawTarget.closest<HTMLButtonElement>("button[data-act-toggle]");
    if (actBtn?.dataset.actToggle) {
      const id = actBtn.dataset.actToggle;
      focusedKey = `act:${id}`;
      virtualList.setFocusedKey(focusedKey);
      if (collapsedActs.has(id)) collapsedActs.delete(id);
      else collapsedActs.add(id);
      repaint();
    }
  };

  const onFocusIn = (event: Event) => {
    const rawTarget = event.target as HTMLElement | null;
    const item = rawTarget && typeof rawTarget.closest === "function"
      ? rawTarget.closest<HTMLElement>("[role=\"treeitem\"]")
      : null;
    const key = item?.dataset?.vlistKey ?? null;
    if (key && key !== focusedKey) {
      syncRovingTabIndex(key);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (visibleNodes.length === 0) return;
    const rawTarget = event.target as HTMLElement | null;
    const itemEl = rawTarget && typeof rawTarget.closest === "function"
      ? rawTarget.closest<HTMLElement>("[role=\"treeitem\"]")
      : null;
    const currentKey = itemEl?.dataset?.vlistKey ?? focusedKey;
    let currentIdx = currentKey ? visibleNodes.findIndex((n) => n.key === currentKey) : -1;
    if (currentIdx === -1) {
      currentIdx = visibleNodes.findIndex(isFocusableNode);
    }
    if (currentIdx === -1) return;
    const node = visibleNodes[currentIdx];

    switch (event.key) {
      case "ArrowDown": {
        const nextIdx = findNextFocusable(currentIdx, 1);
        if (nextIdx !== -1) {
          event.preventDefault?.();
          focusNodeAt(nextIdx);
        }
        break;
      }
      case "ArrowUp": {
        const prevIdx = findNextFocusable(currentIdx, -1);
        if (prevIdx !== -1) {
          event.preventDefault?.();
          focusNodeAt(prevIdx);
        }
        break;
      }
      case "Home": {
        const firstIdx = visibleNodes.findIndex(isFocusableNode);
        if (firstIdx !== -1) {
          event.preventDefault?.();
          focusNodeAt(firstIdx);
        }
        break;
      }
      case "End": {
        for (let i = visibleNodes.length - 1; i >= 0; i--) {
          if (isFocusableNode(visibleNodes[i])) {
            event.preventDefault?.();
            focusNodeAt(i);
            break;
          }
        }
        break;
      }
      case "ArrowRight": {
        event.preventDefault?.();
        if (node.kind === "volume" || node.kind === "act") {
          if (node.collapsed) {
            toggleNodeCollapse(node, false);
            focusedKey = node.key;
            repaint();
            virtualList.setFocusedKey(node.key, true);
          } else {
            const nextIdx = findNextFocusable(currentIdx, 1);
            const nextNode = nextIdx !== -1 ? visibleNodes[nextIdx] : null;
            if (nextNode && (nextNode.level ?? 1) > (node.level ?? 1)) {
              focusNodeAt(nextIdx);
            }
          }
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault?.();
        if ((node.kind === "volume" || node.kind === "act") && !node.collapsed) {
          toggleNodeCollapse(node, true);
          focusedKey = node.key;
          repaint();
          virtualList.setFocusedKey(node.key, true);
        } else if (node.parentKey) {
          const parentIdx = visibleNodes.findIndex((n) => n.key === node.parentKey);
          if (parentIdx !== -1) focusNodeAt(parentIdx);
        }
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault?.();
        if (node.kind === "chapter") {
          onSelect(node.id);
        } else if (node.kind === "volume" || node.kind === "act") {
          toggleNodeCollapse(node);
          focusedKey = node.key;
          repaint();
          virtualList.setFocusedKey(node.key, true);
        }
        break;
      }
      default:
        break;
    }
  };

  container.addEventListener("click", onClick);
  container.addEventListener("focusin", onFocusIn);
  container.addEventListener("keydown", onKeyDown);

  function repaint(): void {
    const needle = filterText.trim().toLowerCase();
    if (mode === "flat" || !lastTree) {
      const filtered = needle
        ? lastFlatDocs.filter((item) => item.title.toLowerCase().includes(needle))
        : lastFlatDocs;
      visibleNodes = filtered.map((item) => ({
        kind: "chapter" as const,
        key: `doc:${item.id}`,
        level: 1 as const,
        parentKey: null,
        id: item.id,
        title: item.title,
      }));
    } else {
      visibleNodes = flattenNovelTree(lastTree, collapsedVolumes, collapsedActs, filterText);
    }

    if (!focusedKey || !visibleNodes.some((n) => n.key === focusedKey && isFocusableNode(n))) {
      const activeNode = visibleNodes.find((n) => n.kind === "chapter" && n.id === currentActiveId);
      const firstFocusable = visibleNodes.find(isFocusableNode);
      focusedKey = activeNode?.key ?? firstFocusable?.key ?? null;
      virtualList.setFocusedKey(focusedKey);
    }

    virtualList.setItems(visibleNodes);
  }

  function scrollToActive(): void {
    if (!currentActiveId) return;
    const activeIdx = visibleNodes.findIndex((n) => n.kind === "chapter" && n.id === currentActiveId);
    if (activeIdx !== -1) {
      virtualList.scrollToIndex(activeIdx);
    }
  }

  return {
    renderFlat(documents, activeId) {
      mode = "flat";
      lastTree = null;
      lastFlatDocs = documents;
      currentActiveId = activeId;
      repaint();
    },
    renderNovelTree(tree, activeId) {
      mode = "tree";
      lastTree = tree;
      currentActiveId = activeId;
      repaint();
    },
    updateActiveId(activeId) {
      if (currentActiveId === activeId) return;
      currentActiveId = activeId;
      for (const btn of container.querySelectorAll<HTMLButtonElement>("button[data-doc-id]")) {
        const active = btn.dataset.docId === activeId;
        btn.setAttribute("aria-current", String(active));
        btn.setAttribute("aria-selected", String(active));
      }
    },
    scrollToActive,
    setFilter(query) {
      filterText = query;
      repaint();
    },
    destroy() {
      container.removeEventListener("click", onClick);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("keydown", onKeyDown);
      virtualList.destroy();
    },
  };
}
