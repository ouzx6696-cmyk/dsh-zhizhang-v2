import type { WorkspaceSnapshot } from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";
import { createButton, createCard } from "../ui/primitives.ts";

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
 * document is currently active. Uses unified Card & Button primitives.
 */
export function createStudyHome(container: HTMLElement, callbacks: StudyHomeCallbacks) {
  let productFilter: "all" | "fanqie" | "toutiao" = "all";
  let lastSnapshot: WorkspaceSnapshot = {};

  function paint(): void {
    const projects = lastSnapshot.projects ?? [];
    const lastActive = readLastActiveRef();
    const canResume = Boolean(lastActive && projects.some((p) => p.id === lastActive.projectId));

    const wrap = el("div", { className: "study-home" });
    const intro = el("header", { className: "study-intro" });
    intro.append(
      el("p", { className: "eyebrow study-eyebrow", text: "DeepSeek Harness 创作协同插件 · 书斋" }),
      el("h1", { text: "从这里落笔" }),
      el("p", {
        className: "lead",
        text: "把创作交给 DsH Agent，把流程、上下文与作者主权交给织章——双模式协作、渐进技法卡与逐段 Diff 审阅同台闭环。",
      }),
    );
    wrap.append(intro);

    if (canResume && lastActive) {
      const resumeBtn = createButton({
        label: "一键续写上一章",
        variant: "primary",
        size: "md",
        onClick: () => callbacks.onResumeDocument(lastActive.projectId, lastActive.documentId),
      });
      const hero = createCard({
        variant: "elevated",
        padding: "md",
        eyebrow: "上次写作",
        title: `${lastActive.projectName || "项目"} · ${lastActive.title || "未命名章节"}`,
        headerAction: resumeBtn,
        className: "hero-resume-card",
      });
      wrap.append(hero);
    }

    const ctaRow = el("div", { className: "actions study-cta-row" });
    const wizardBtn = createButton({
      label: "三步开新书",
      variant: "primary",
      size: "lg",
      onClick: callbacks.onOpenWizard,
    });
    const demoBtn = createButton({
      label: "一键导入示例书",
      variant: "secondary",
      size: "lg",
      onClick: callbacks.onImportDemoBook,
    });
    ctaRow.append(wizardBtn, demoBtn);
    wrap.append(ctaRow);

    const shelfBar = el("div", { className: "study-shelf-bar" });
    const filterRow = el("div", { className: "segmented" });
    for (const [id, label] of [["all", "全部书架"], ["fanqie", "番茄连载"], ["toutiao", "头条创作"]] as const) {
      const btn = createButton({
        label,
        variant: "ghost",
        size: "sm",
        active: productFilter === id,
        selected: productFilter === id,
        onClick: () => {
          productFilter = id;
          paint();
        },
      });
      filterRow.append(btn);
    }
    const countLabel = el("span", {
      className: "muted-copy tabular study-shelf-count",
      text: `${projects.length} 部作品`,
    });
    shelfBar.append(filterRow, countLabel);
    wrap.append(shelfBar);

    const visibleProjects = productFilter === "all"
      ? projects
      : projects.filter((p) => p.product === productFilter);

    const grid = el("div", { className: "bookshelf-grid" });
    if (visibleProjects.length === 0) {
      const emptyBox = createCard({
        variant: "subtle",
        padding: "lg",
        tag: "div",
        className: "bookshelf-empty",
        body: el("p", {
          className: "muted-copy",
          text: "书架暂无作品，点击「三步开新书」或「一键导入示例书」立即起步。",
        }),
      });
      grid.append(emptyBox);
    } else {
      for (const proj of visibleProjects) {
        const openBtn = createButton({
          label: "进入书桌",
          variant: "secondary",
          size: "sm",
          onClick: (event) => {
            event.stopPropagation();
            callbacks.onSelectProject(proj.id);
          },
        });
        const card = createCard({
          variant: "interactive",
          padding: "md",
          eyebrow: proj.product === "fanqie" ? "番茄连载" : "头条创作",
          title: proj.name,
          footer: openBtn,
          className: "bookshelf-card",
          onClick: () => callbacks.onSelectProject(proj.id),
        });
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
