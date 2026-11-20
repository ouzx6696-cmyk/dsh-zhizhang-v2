import type {
  ChapterTreeItemDto,
  DocumentSummary,
  NovelTreeDto,
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

export interface TreeSidebarController {
  renderFlat(documents: readonly DocumentSummary[], activeId: string): void;
  renderNovelTree(tree: NovelTreeDto, activeId: string): void;
  updateActiveId(activeId: string): void;
  setFilter(query: string): void;
  destroy(): void;
}

/**
 * Renders either the virtualized flat document list (<=40 DOM rows even for
 * 650+ chapters) or a collapsible 3-tier Volume -> Act -> Chapter tree while
 * preserving `#documents button` semantics for navigation and testing.
 */
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

  function buildChapterButton(item: {
    readonly id: string;
    readonly title: string;
    readonly state?: string;
    readonly charCount?: number;
  }): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-nav-btn";
    button.dataset.docId = item.id;
    button.setAttribute("aria-current", String(item.id === currentActiveId));

    const titleSpan = el("span", item.title || "微头条", "doc-nav-title");
    button.append(titleSpan);

    if (item.state || typeof item.charCount === "number") {
      const meta = el("span", "", "doc-nav-meta tabular");
      const badge = item.state ? (CHAPTER_STATE_LABELS[item.state] ?? item.state) : "";
      const chars = typeof item.charCount === "number" && item.charCount > 0 ? formatCharCount(item.charCount) : "";
      meta.textContent = [badge, chars].filter(Boolean).join(" · ");
      button.append(meta);
    }
    return button;
  }

  const virtualList = createVirtualList<{
    readonly id: string;
    readonly title: string;
    readonly state?: string;
    readonly charCount?: number;
  }>(container, {
    rowHeight: 38,
    emptyText: "暂无稿件，请先新建。",
    renderItem: buildChapterButton,
  });

  const onClick = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-doc-id]");
    if (!target || !target.dataset.docId) return;
    onSelect(target.dataset.docId);
  };
  container.addEventListener("click", onClick);

  function repaint(): void {
    const needle = filterText.trim().toLowerCase();
    if (mode === "flat" || !lastTree || (lastTree.volumes.length === 0 && !needle && lastTree.chapters.length > 80)) {
      const source = lastTree
        ? lastTree.chapters.map((ch) => ({ id: ch.id, title: ch.title, state: ch.state, charCount: ch.charCount }))
        : lastFlatDocs;
      const filtered = needle
        ? source.filter((item) => item.title.toLowerCase().includes(needle))
        : source;
      virtualList.setItems(filtered);
      return;
    }

    const filteredChapters = needle
      ? lastTree.chapters.filter(
          (ch) => ch.title.toLowerCase().includes(needle) || ch.summary.toLowerCase().includes(needle),
        )
      : lastTree.chapters;

    if (lastTree.volumes.length === 0) {
      virtualList.setItems(
        filteredChapters.map((ch) => ({ id: ch.id, title: ch.title, state: ch.state, charCount: ch.charCount })),
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    const byVolume = new Map<string | null, ChapterTreeItemDto[]>();
    for (const ch of filteredChapters) {
      const bucket = byVolume.get(ch.volumeId) ?? [];
      bucket.push(ch);
      byVolume.set(ch.volumeId, bucket);
    }

    for (const vol of lastTree.volumes) {
      const volChapters = byVolume.get(vol.id) ?? [];
      if (needle && volChapters.length === 0) continue;
      const volChars = volChapters.reduce((sum, ch) => sum + ch.charCount, 0);

      const group = el("div", "", "tree-volume");
      const header = el("button", "", "tree-toggle-row");
      header.type = "button";
      const isCollapsed = collapsedVolumes.has(vol.id) && !needle;
      header.textContent = `${isCollapsed ? "▸" : "▾"} ${vol.title}（${volChapters.length}章${volChars > 0 ? ` · ${formatCharCount(volChars)}` : ""}）`;
      header.onclick = () => {
        if (collapsedVolumes.has(vol.id)) collapsedVolumes.delete(vol.id);
        else collapsedVolumes.add(vol.id);
        repaint();
      };
      group.append(header);

      if (!isCollapsed) {
        const volActs = lastTree.acts.filter((act) => act.volumeId === vol.id);
        for (const act of volActs) {
          const actChapters = volChapters.filter((ch) => ch.actId === act.id);
          if (needle && actChapters.length === 0) continue;
          const actWrap = el("div", "", "tree-act");
          const actBtn = el("button", "", "tree-act-toggle");
          actBtn.type = "button";
          const actCollapsed = collapsedActs.has(act.id) && !needle;
          actBtn.textContent = `${actCollapsed ? "▸" : "▾"} ${act.title}（${actChapters.length}）`;
          actBtn.onclick = () => {
            if (collapsedActs.has(act.id)) collapsedActs.delete(act.id);
            else collapsedActs.add(act.id);
            repaint();
          };
          actWrap.append(actBtn);
          if (!actCollapsed) {
            for (const ch of actChapters) actWrap.append(buildChapterButton(ch));
          }
          group.append(actWrap);
        }
        const directChapters = volChapters.filter((ch) => !ch.actId);
        for (const ch of directChapters) group.append(buildChapterButton(ch));
      }
      fragment.append(group);
    }

    const ungrouped = byVolume.get(null) ?? [];
    if (ungrouped.length > 0) {
      const misc = el("div", "", "tree-volume");
      misc.append(el("div", `未分卷章节（${ungrouped.length}）`, "tree-ungrouped-label"));
      for (const ch of ungrouped) misc.append(buildChapterButton(ch));
      fragment.append(misc);
    }

    if (fragment.childElementCount === 0) {
      fragment.append(el("p", "暂无匹配章节。", "muted-copy"));
    }
    container.replaceChildren(fragment);
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
