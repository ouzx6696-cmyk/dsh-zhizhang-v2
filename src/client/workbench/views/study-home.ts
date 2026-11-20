import type { WorkspaceSnapshot } from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";

export interface LastActiveRef {
  readonly projectId: string;
  readonly documentId: string;
  readonly projectName: string;
  readonly title: string;
}

export interface StudyHomeCallbacks {
  readonly onSelectProject: (projectId: string) => void;
  readonly onResumeDocument: (projectId: string, documentId: string) => void;
  readonly onOpenWizard: () => void;
  readonly onImportDemoBook: () => void;
}

export const LAST_ACTIVE_STORAGE_KEY = "zhizhang:lastActive";

export function readLastActiveRef(): LastActiveRef | null {
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastActiveRef>;
    if (typeof parsed.projectId !== "string" || typeof parsed.documentId !== "string") return null;
    if (!parsed.projectId || !parsed.documentId) return null;
    return {
      projectId: parsed.projectId,
      documentId: parsed.documentId,
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
    };
  } catch {
    return null;
  }
}

export function writeLastActiveRef(ref: LastActiveRef): void {
  try {
    localStorage.setItem(LAST_ACTIVE_STORAGE_KEY, JSON.stringify(ref));
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

/**
 * Cold-start bookshelf & quick-resume hero rendered inside `#empty` when no
 * document is currently active. Zero extra HTML `#id` queries.
 */
export function createStudyHome(container: HTMLElement, callbacks: StudyHomeCallbacks) {
  let productFilter: "all" | "fanqie" | "toutiao" = "all";
  let lastSnapshot: WorkspaceSnapshot = {};

  function paint(): void {
    const projects = lastSnapshot.projects ?? [];
    const lastActive = readLastActiveRef();
    const canResume = Boolean(lastActive && projects.some((p) => p.id === lastActive.projectId));

    const wrap = el("div", { className: "study-home" });
    wrap.append(
      el("p", { className: "eyebrow", text: "DeepSeek Harness 作者工作台 · 书斋" }),
      el("h1", { text: "从这里落笔" }),
      el("p", {
        className: "lead",
        text: "作者主权三态隔离、人物视角知情边界与逐段合稿在同一书斋内闭环运行。",
      }),
    );

    if (canResume && lastActive) {
      const hero = el("article", { className: "panel-card hero-resume-card" });
      hero.append(
        el("p", { className: "eyebrow", text: "上次写作" }),
        el("h2", { text: `${lastActive.projectName || "项目"} · ${lastActive.title || "未命名章节"}` }),
      );
      const resumeBtn = el("button", { className: "primary", text: "一键续写上一章" });
      resumeBtn.type = "button";
      resumeBtn.onclick = () => callbacks.onResumeDocument(lastActive.projectId, lastActive.documentId);
      hero.append(resumeBtn);
      wrap.append(hero);
    }

    const ctaRow = el("div", { className: "actions" });
    const wizardBtn = el("button", { className: "primary", text: "三步开新书" });
    wizardBtn.type = "button";
    wizardBtn.onclick = callbacks.onOpenWizard;

    const demoBtn = el("button", { text: "一键导入示例书" });
    demoBtn.type = "button";
    demoBtn.onclick = callbacks.onImportDemoBook;
    ctaRow.append(wizardBtn, demoBtn);
    wrap.append(ctaRow);

    const filterRow = el("div", { className: "segmented" });
    for (const [id, label] of [["all", "全部书架"], ["fanqie", "番茄连载"], ["toutiao", "头条创作"]] as const) {
      const btn = el("button", { className: productFilter === id ? "active" : undefined, text: label });
      btn.type = "button";
      btn.onclick = () => {
        productFilter = id;
        paint();
      };
      filterRow.append(btn);
    }
    wrap.append(filterRow);

    const visibleProjects = productFilter === "all"
      ? projects
      : projects.filter((p) => p.product === productFilter);

    const grid = el("div", { className: "bookshelf-grid" });
    if (visibleProjects.length === 0) {
      grid.append(el("p", { className: "muted-copy", text: "书架暂无作品，点击「三步开新书」或「一键导入示例书」立即起步。" }));
    } else {
      for (const proj of visibleProjects) {
        const card = el("article", { className: "panel-card bookshelf-card" });
        card.append(
          el("p", { className: "setting-meta", text: proj.product === "fanqie" ? "番茄连载" : "头条创作" }),
          el("p", { className: "setting-title", text: proj.name }),
        );
        const openBtn = el("button", { text: "进入书桌" });
        openBtn.type = "button";
        openBtn.onclick = () => callbacks.onSelectProject(proj.id);
        card.append(openBtn);
        grid.append(card);
      }
    }
    wrap.append(grid);
    container.replaceChildren(wrap);
  }

  return {
    update(snapshot: WorkspaceSnapshot): void {
      lastSnapshot = snapshot;
      paint();
    },
  };
}
