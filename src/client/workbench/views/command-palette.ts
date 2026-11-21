import type { DocumentSummary, SearchHitDto } from "../../../contracts/workspace-dto.ts";
import type { WorkspaceViewId } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

export interface CommandPaletteDeps {
  readonly dialog: HTMLDialogElement;
  readonly getDocuments: () => readonly DocumentSummary[];
  readonly getProjectId: () => string;
  readonly supportsStudioViews: () => boolean;
  readonly searchRemote: (query: string) => Promise<readonly SearchHitDto[]>;
  readonly onSelectDocument: (documentId: string) => void;
  readonly onSwitchView: (viewId: WorkspaceViewId) => void;
  readonly onToggleFocusMode: () => void;
}

const VIEW_ENTRIES: readonly { readonly id: WorkspaceViewId; readonly label: string }[] = [
  { id: "writing", label: "视图：沉浸写作台" },
  { id: "outline", label: "视图：卷幕章大纲板" },
  { id: "worldbook", label: "视图：动态设定库与伏笔" },
  { id: "deconstruct", label: "视图：拆书样本库" },
  { id: "techniques", label: "视图：技法卡片库" },
  { id: "io", label: "视图：本地导入与导出" },
];

/**
 * Accessible `<dialog>` command palette (`Ctrl/Cmd+K`) & unified FTS5 workspace
 * search modal (`Ctrl/Cmd+Shift+F`).
 */
export function createCommandPalette(deps: CommandPaletteDeps) {
  let mode: "jump" | "search" = "jump";
  let timer: number | undefined;
  let searchSeq = 0;

  function close(): void {
    window.clearTimeout(timer);
    if (deps.dialog.open) deps.dialog.close();
  }

  function renderResults(list: HTMLElement, rows: readonly {
    title: string;
    meta: string;
    onPick: () => void;
  }[]): void {
    list.replaceChildren();
    if (rows.length === 0) {
      list.append(el("p", "未找到匹配结果。", "muted-copy"));
      return;
    }
    for (const row of rows) {
      const btn = createButton({
        label: "",
        variant: "ghost",
        size: "sm",
        className: "palette-item",
        onClick: () => {
          close();
          row.onPick();
        },
      });
      const title = el("span", row.title, "palette-item-title");
      const meta = el("span", row.meta, "palette-item-meta");
      btn.replaceChildren(title, meta);
      list.append(btn);
    }
  }

  function open(nextMode: "jump" | "search"): void {
    mode = nextMode;
    deps.dialog.replaceChildren();

    const closeBtn = createButton({
      label: "关闭",
      variant: "ghost",
      size: "sm",
      className: "notice-dismiss",
      onClick: close,
    });

    const searchField = createInput({
      kind: "search",
      ariaLabel: mode === "jump" ? "快速跳转" : "全书全文检索",
      placeholder: mode === "jump"
        ? "输入章节标题、视图名称或命令（如 大纲 / 专注）…"
        : "输入正文关键词、设定词或技法关键词（支持中英文子串）…",
      className: "palette-input",
    });

    const results = el("div", "", "palette-results");

    const card = createCard({
      tag: "div",
      variant: "elevated",
      padding: "lg",
      className: "modal-card palette-card",
      title: mode === "jump" ? "快速跳转（Ctrl/Cmd + K）" : "全书全文检索（FTS5 · Ctrl/Cmd + Shift + F）",
      headerAction: closeBtn,
      body: [searchField.root, results],
    });

    deps.dialog.append(card);

    deps.dialog.oncancel = (event) => {
      event.preventDefault();
      close();
    };

    const runQuery = () => {
      const q = searchField.getValue().trim();
      if (mode === "jump") {
        const lower = q.toLowerCase();
        const items: { title: string; meta: string; onPick: () => void }[] = [];
        if (!lower || "专注禅定".includes(lower) || "zen".includes(lower)) {
          items.push({
            title: "切换专注写作模式（收起/展开侧栏）",
            meta: "快捷动作",
            onPick: deps.onToggleFocusMode,
          });
        }
        if (deps.supportsStudioViews()) {
          for (const view of VIEW_ENTRIES) {
            if (!lower || view.label.toLowerCase().includes(lower) || view.id.includes(lower)) {
              items.push({
                title: view.label,
                meta: "工作区视图",
                onPick: () => deps.onSwitchView(view.id),
              });
            }
          }
        }
        const docs = deps.getDocuments();
        let matched = 0;
        for (const doc of docs) {
          if (!lower || doc.title.toLowerCase().includes(lower)) {
            items.push({
              title: doc.title || "微头条",
              meta: "章节 / 稿件",
              onPick: () => deps.onSelectDocument(doc.id),
            });
            matched += 1;
            if (matched >= 30) break;
          }
        }
        renderResults(results, items);
        return;
      }

      if (!q) {
        results.replaceChildren(el("p", "请输入检索词开始检索。", "muted-copy"));
        return;
      }
      if (!deps.getProjectId() || !deps.supportsStudioViews()) {
        results.replaceChildren(el("p", "全文检索需先打开支持多视图长篇工程的项目。", "muted-copy"));
        return;
      }

      const seq = ++searchSeq;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const hits = await deps.searchRemote(q);
          if (seq !== searchSeq) return;
          renderResults(
            results,
            hits.map((hit) => ({
              title: `${hit.title} · ${hit.subtitle}`,
              meta: hit.snippet,
              onPick: () => {
                if (hit.scope === "chapter") deps.onSelectDocument(hit.id);
                else if (hit.scope === "lore") deps.onSwitchView("worldbook");
                else if (hit.scope === "deconstruction") deps.onSwitchView("deconstruct");
                else if (hit.scope === "technique") deps.onSwitchView("techniques");
              },
            })),
          );
        } catch (err) {
          results.replaceChildren(el("p", err instanceof Error ? err.message : String(err), "status-warning"));
        }
      }, 180);
    };

    searchField.control.addEventListener("input", runQuery);
    deps.dialog.showModal();
    searchField.control.focus();
    runQuery();
  }

  return { open, close };
}
