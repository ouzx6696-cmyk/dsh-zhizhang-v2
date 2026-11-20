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
      readonly volume: VolumeDto;
      readonly count: number;
      readonly chars: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "act";
      readonly key: string;
      readonly act: ActDto;
      readonly count: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "ungrouped";
      readonly key: string;
      readonly count: number;
    }
  | {
      readonly kind: "chapter";
      readonly key: string;
      readonly id: string;
      readonly title: string;
      readonly state?: string;
      readonly charCount?: number;
      readonly syncStatus?: "clean" | "dirty";
    };

export interface TreeSidebarController {
  renderFlat(documents: readonly DocumentSummary[], activeId: string): void;
  renderNovelTree(tree: NovelTreeDto, activeId: string): void;
  updateActiveId(activeId: string): void;
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
    nodes.push({
      kind: "volume",
      key: `vol:${vol.id}`,
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
      nodes.push({
        kind: "act",
        key: `act:${act.id}`,
        act,
        count: actChapters.length,
        collapsed: isActCollapsed,
      });
      if (isActCollapsed) continue;
      for (const ch of actChapters) {
        nodes.push({
          kind: "chapter",
          key: `ch:${ch.id}`,
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
        id: ch.id,
        title: ch.title,
        state: ch.state,
        charCount: ch.charCount,
        syncStatus: ch.syncStatus,
      });
    }
  }

  if (ungrouped.length > 0) {
    nodes.push({ kind: "ungrouped", key: "vol:ungrouped", count: ungrouped.length });
    for (const ch of ungrouped) {
      nodes.push({
        kind: "chapter",
        key: `ch:${ch.id}`,
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
): TreeSidebarController {
  let mode: "flat" | "tree" = "flat";
  let filterText = "";
  let currentActiveId = "";
  let lastFlatDocs: readonly DocumentSummary[] = [];
  let lastTree: NovelTreeDto | null = null;
  const collapsedVolumes = new Set<string>();
  const collapsedActs = new Set<string>();

  function renderFlatNode(node: FlatTreeNode): HTMLElement {
    if (node.kind === "volume") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-toggle-row tree-vol-row";
      btn.dataset.volumeToggle = node.volume.id;
      btn.setAttribute("aria-expanded", String(!node.collapsed));
      btn.textContent = `${node.collapsed ? "▸" : "▾"} ${node.volume.title}（${node.count}章${node.chars > 0 ? ` · ${formatCharCount(node.chars)}` : ""}）`;
      return btn;
    }
    if (node.kind === "act") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-act-toggle tree-act-row";
      btn.dataset.actToggle = node.act.id;
      btn.setAttribute("aria-expanded", String(!node.collapsed));
      btn.textContent = `${node.collapsed ? "▸" : "▾"} ${node.act.title}（${node.count}）`;
      return btn;
    }
    if (node.kind === "ungrouped") {
      return el("div", `未分卷章节（${node.count}）`, "tree-ungrouped-label");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-nav-btn";
    button.dataset.docId = node.id;
    button.setAttribute("aria-current", String(node.id === currentActiveId));

    const badge = node.state ? (CHAPTER_STATE_LABELS[node.state] ?? node.state) : "";
    const chars = typeof node.charCount === "number" && node.charCount > 0 ? formatCharCount(node.charCount) : "";
    const syncTag = node.syncStatus === "dirty" ? "待同步" : "";
    const metaText = [badge, chars, syncTag].filter(Boolean).join(" · ");

    button.append(el("span", node.title || "微头条", "doc-nav-title"));
    if (metaText) {
      button.append(el("span", metaText, "doc-nav-meta tabular"));
    }
    return button;
  }

  const virtualList = createVirtualList<FlatTreeNode>(container, {
    rowHeight: 36,
    overscan: 2,
    directThreshold: 40,
    emptyText: "暂无匹配章节或稿件，请先新建。",
    renderItem: renderFlatNode,
  });

  const onClick = (event: Event) => {
    const rawTarget = event.target as HTMLElement | null;
    if (!rawTarget || typeof rawTarget.closest !== "function") return;
    const docBtn = rawTarget.closest<HTMLButtonElement>("button[data-doc-id]");
    if (docBtn?.dataset.docId) {
      onSelect(docBtn.dataset.docId);
      return;
    }
    const volBtn = rawTarget.closest<HTMLButtonElement>("button[data-volume-toggle]");
    if (volBtn?.dataset.volumeToggle) {
      const id = volBtn.dataset.volumeToggle;
      if (collapsedVolumes.has(id)) collapsedVolumes.delete(id);
      else collapsedVolumes.add(id);
      repaint();
      return;
    }
    const actBtn = rawTarget.closest<HTMLButtonElement>("button[data-act-toggle]");
    if (actBtn?.dataset.actToggle) {
      const id = actBtn.dataset.actToggle;
      if (collapsedActs.has(id)) collapsedActs.delete(id);
      else collapsedActs.add(id);
      repaint();
    }
  };
  container.addEventListener("click", onClick);

  function repaint(): void {
    const needle = filterText.trim().toLowerCase();
    if (mode === "flat" || !lastTree) {
      const filtered = needle
        ? lastFlatDocs.filter((item) => item.title.toLowerCase().includes(needle))
        : lastFlatDocs;
      virtualList.setItems(
        filtered.map((item) => ({
          kind: "chapter" as const,
          key: `doc:${item.id}`,
          id: item.id,
          title: item.title,
        })),
      );
      return;
    }

    virtualList.setItems(flattenNovelTree(lastTree, collapsedVolumes, collapsedActs, filterText));
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
        btn.setAttribute("aria-current", String(btn.dataset.docId === activeId));
      }
    },
    setFilter(query) {
      filterText = query;
      repaint();
    },
    destroy() {
      container.removeEventListener("click", onClick);
      virtualList.destroy();
    },
  };
}
