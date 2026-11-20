import type {
  AnchorPoint,
  NovelTreeDto,
  SettingEntryDto,
  SettingFactDto,
  WorkspaceSnapshot,
} from "../../../contracts/workspace-dto.ts";
import { el } from "../store.ts";
import { createContextPreviewPanel } from "../views/context-preview.ts";
import { createIoView } from "../views/io-view.ts";
import { createLibraryView } from "../views/library-view.ts";
import { createOutlineBoardView } from "../views/outline-board.ts";
import { createWorldbookView } from "../views/worldbook-view.ts";
import type { ProductLineUiModule, ProductLineUiSession, WorkbenchShellHost, WorkspaceViewId } from "./types.ts";

const DECISION_LABELS: Readonly<Record<string, string>> = {
  approved: "已确认",
  rejected: "已拒绝",
  pending: "待确认",
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workbench element #${id}`);
  return node as T;
}

export const fanqieUiModule: ProductLineUiModule = {
  id: "fanqie",
  displayName: "番茄",
  lockedStates: ["final"],
  stateLabels: {
    planned: "待写",
    drafting: "写作中",
    drafted: "已有草稿",
    reviewed: "已审稿",
    final: "已定稿",
  },
  visibleTabs: ["workflow", "planning", "continuity", "runs"],

  documentTypeLabel() {
    return "番茄连载";
  },

  wordCountHint() {
    return "建议 2,000–2,500 字";
  },

  mount(host: WorkbenchShellHost): ProductLineUiSession {
    let chapterTitles = new Map<string, string>();
    let settingProject: string | undefined;
    let settingsKey: string | undefined;
    let chaptersSelectKey: string | undefined;
    let planDocument: string | undefined;
    let contextDoc: string | undefined;
    let treeLoadSeq = 0;

    const contextPreview = createContextPreviewPanel(byId("context-preview-root"), host);
    const outlineView = createOutlineBoardView(byId("view-outline"), host);
    const worldbookView = createWorldbookView(byId("view-worldbook"), host);
    const deconstructView = createLibraryView(byId("view-deconstruct"), host, "deconstruct");
    const techniqueView = createLibraryView(byId("view-techniques"), host, "techniques");
    const ioView = createIoView(byId("view-io"), host);

    function settingPoint({ chapterId, point }: AnchorPoint): string {
      return `${chapterTitles.get(chapterId) ?? chapterId}第 ${point} 段`;
    }

    function populateSettingChapters(select: HTMLSelectElement): void {
      const value = select.value;
      const fragment = document.createDocumentFragment();
      fragment.append(new Option(select.dataset.default ?? "", ""));
      for (const [id, title] of chapterTitles) {
        fragment.append(new Option(title, id));
      }
      select.replaceChildren(fragment);
      if (chapterTitles.has(value)) select.value = value;
    }

    function syncSettingExpiry(): void {
      const form = byId<HTMLFormElement>("setting-proposal");
      const toChapter = form.elements.namedItem("toChapter") as HTMLSelectElement;
      const toPoint = form.elements.namedItem("toPoint") as HTMLInputElement;
      const expires = Boolean(toChapter.value);
      byId("setting-to-point").hidden = !expires;
      toPoint.disabled = !expires;
    }

    function appendSettings(target: HTMLElement, entries: readonly SettingEntryDto[]): void {
      if (entries.length === 0 && target.childElementCount === 0) {
        target.append(el("p", "暂无设定提案。", "muted-copy"));
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        const row = el("article", "", "setting-item");
        const titleLine = el(
          "p",
          `${entry.fact.id} · ${entry.fact.note} · ${DECISION_LABELS[entry.decision] ?? entry.decision}${entry.fact.locked ? " · 已锁定" : ""}`,
          "setting-title",
        );
        const { source, effectiveFrom, effectiveTo, knownFrom } = entry.fact;
        const metaLine = el(
          "p",
          [
            `来源 ${source}`,
            `${settingPoint(effectiveFrom)}生效`,
            effectiveTo ? `${settingPoint(effectiveTo)}起失效` : "",
            ...Object.entries(knownFrom).map(([name, at]) => `${name}在${settingPoint(at)}知情`),
          ].filter(Boolean).join(" · "),
          "setting-meta",
        );
        row.append(titleLine, metaLine);
        if (entry.decision === "pending") {
          const actions = el("div", "", "actions");
          for (const [label, accept] of [["确认设定", true], ["拒绝提案", false]] as const) {
            const button = el("button", label, accept ? "primary" : undefined);
            button.type = "button";
            button.onclick = () =>
              void host.perform(() =>
                host.change("setting.decide", { projectId: host.getState().projectId, proposalId: entry.id, accept }),
              );
            actions.append(button);
          }
          row.append(actions);
        }
        fragment.append(row);
      }
      target.append(fragment);
    }

    // Bind Fanqie sidebar tree quick controls
    const treeFilter = byId<HTMLInputElement>("tree-filter");
    const docContainer = byId("documents");
    treeFilter.addEventListener("input", () => {
      const q = treeFilter.value.trim().toLowerCase();
      for (const btn of docContainer.querySelectorAll<HTMLButtonElement>("button.doc-nav-btn")) {
        const text = (btn.textContent ?? "").toLowerCase();
        btn.hidden = Boolean(q && !text.includes(q));
      }
    });

    host.bindClick("tree-new-volume", async () => {
      const { projectId } = host.getState();
      if (!projectId) return;
      const title = await host.modal.prompt({
        title: "新建卷",
        message: "输入卷名称：",
        label: "卷名",
        placeholder: "例如：第一卷 · 苍梧风云",
        confirmLabel: "创建卷",
      });
      if (!title?.trim()) return;
      await host.request("volume.create", { projectId, title: title.trim() });
      host.notice("已创建卷");
      const tree = await host.request<NovelTreeDto>("tree.get", { projectId });
      host.setDirectoryTree(tree);
    });

    byId("tree-open-outline").onclick = () => host.switchWorkspaceView("outline");

    // Bind Fanqie workflow actions
    host.bindClick("review-pass", () =>
      host.change("chapter.review", { accept: true }, { savedVersion: true, message: "审稿已通过" }),
    );
    host.bindClick("review-reject", () =>
      host.change("chapter.review", { accept: false }, { savedVersion: true, message: "已记录审稿打回" }),
    );
    host.bindClick("finalize", async () => {
      const confirmed = await host.modal.confirm({
        title: "确认定稿本章",
        message: "定稿后本章正文将锁定为终稿修订，无法继续直接修改。确认将当前修订设为定稿？",
        confirmLabel: "确认定稿",
      });
      if (confirmed) {
        await host.change("draft.finalize", {}, { savedVersion: true, message: "本章已定稿" });
      }
    });

    // Bind Fanqie outline planning form
    host.bindForm("chapter-outline", async (values) => {
      const result = await host.change<{ warnings: string[] }>("chapter.outline", {
        ...values,
        target: Number(values.target),
      });
      if (result.warnings.length) host.notice(result.warnings.join(" · "));
    });

    // Bind Fanqie continuity & multi-character setting proposals
    const settingForm = byId<HTMLFormElement>("setting-proposal");
    (settingForm.elements.namedItem("toChapter") as HTMLSelectElement).onchange = syncSettingExpiry;

    byId("setting-add-person").onclick = () => {
      const template = byId<HTMLTemplateElement>("setting-person-template");
      const person = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      populateSettingChapters(person.querySelector<HTMLSelectElement>("select")!);
      person.querySelector<HTMLButtonElement>("button")!.onclick = () => person.remove();
      byId("setting-people").append(person);
      person.querySelector<HTMLInputElement>("[data-person]")!.focus();
    };

    host.bindForm("setting-proposal", async (values, form) => {
      const { projectId, documentId } = host.getState();
      const from = { chapterId: values.fromChapter || documentId, point: Number(values.point) };
      const people = Array.from(byId("setting-people").children, (row) => {
        const character = row.querySelector<HTMLInputElement>("[data-person]")!.value;
        const chapterId = row.querySelector<HTMLSelectElement>("[data-when]")!.value;
        const point = row.querySelector<HTMLInputElement>("[data-point]")!.value;
        return {
          character,
          at: chapterId || point
            ? { chapterId: chapterId || from.chapterId, point: Number(point || (chapterId ? 1 : from.point)) }
            : undefined,
        };
      });
      await host.change(
        "setting.propose",
        {
          projectId,
          factId: values.factId,
          note: values.note,
          source: values.source,
          from,
          people,
          to: values.toChapter ? { chapterId: values.toChapter, point: Number(values.toPoint) } : undefined,
          locked: values.locked === "on",
        },
        { message: "设定提案已提交，待作者确认后生效" },
      );
      form.reset();
      byId("setting-people").replaceChildren();
      syncSettingExpiry();
    });

    host.bindForm("settings-read", async (values) => {
      const { projectId, documentId } = host.getState();
      const result = await host.request<{ entries: readonly SettingFactDto[] }>("settings.read", {
        projectId,
        character: values.character,
        at: { chapterId: documentId, point: Number(values.point) },
      });
      const container = byId("known-settings");
      container.replaceChildren(
        ...(result.entries.length > 0
          ? result.entries.map(({ note, source, locked, effectiveFrom, effectiveTo }) =>
            el(
              "p",
              [
                note,
                `来源 ${source}`,
                locked ? "已锁定" : "",
                `${settingPoint(effectiveFrom)}生效`,
                effectiveTo ? `${settingPoint(effectiveTo)}起失效` : "",
              ].filter(Boolean).join(" · "),
              "known-item",
            ),
          )
          : [el("p", "此时该人物没有已确认的知情设定。", "muted-copy")]),
      );
    });

    for (const [id, offset] of [["move-up", -1], ["move-down", 1]] as const) {
      host.bindClick(id, async () => {
        const { projectId, documentId, snapshot } = host.getState();
        const chapterIds = (snapshot.documents ?? []).map(({ id: docId }) => docId);
        const position = chapterIds.indexOf(documentId);
        if (position < 0 || position + offset < 0 || position + offset >= chapterIds.length) return;
        [chapterIds[position], chapterIds[position + offset]] = [chapterIds[position + offset], chapterIds[position]];
        const plan = await host.request<{
          asOfSeq: number;
          impact: readonly { id: string; relations: readonly { label: string }[] }[];
        }>("reorder.impact", { projectId, chapterIds });
        const impacts = plan.impact.flatMap(({ id: factId, relations }) =>
          relations.map(({ label }) => `${factId} · ${label} 时序将被翻转`),
        );
        const confirmed = await host.modal.confirm({
          title: "确认调整章节顺序",
          message: impacts.length > 0
            ? "本次章序调整将影响以下已确认设定的时间先后关系，请核对后再提交："
            : "本次章序调整未翻转任何已确认设定的时间先后关系。确认执行调整？",
          details: impacts,
          confirmLabel: "确认调整章序",
        });
        if (confirmed) {
          await host.change(
            "reorder.commit",
            { projectId, chapterIds, asOfSeq: plan.asOfSeq, confirmed: true },
            { message: "章节顺序已更新" },
          );
        }
      });
    }

    host.bindForm("record-evidence", async (values) => {
      await host.change("evidence.record", values, { savedVersion: true, message: "已记录当前修订的正文证据" });
    });

    host.bindClick("evidence-detail", async () => {
      const { documentId, snapshot } = host.getState();
      const form = byId<HTMLFormElement>("record-evidence");
      const factId = (form.elements.namedItem("factId") as HTMLInputElement).value;
      const { value } = await host.request<{
        value: {
          revisionId?: string;
          anchor?: { chapterId: string; point: string };
          quoteRange?: { start: number; end: number };
        };
      }>("evidence.detail", { documentId, factId });
      const output = byId("evidence-result");
      const active = snapshot.active;
      const isCurrent = value.anchor?.chapterId === documentId && value.revisionId === active?.revisionId;
      output.textContent = isCurrent && value.quoteRange && active?.body
        ? `第 ${value.anchor!.point} 段 · ${active.body.slice(value.quoteRange.start, value.quoteRange.end)}`
        : value.revisionId
          ? `第 ${value.anchor?.point ?? "?"} 段 · 修订 ${value.revisionId.slice(0, 8)}`
          : "暂无正文证据";
    });

    host.bindClick("settings-more", async () => {
      const { projectId } = host.getState();
      const button = byId<HTMLButtonElement>("settings-more");
      const result = await host.request<{ entries: readonly SettingEntryDto[]; cursor: number | null }>("settings.history", {
        projectId,
        before: Number(button.dataset.cursor),
      });
      appendSettings(byId("settings"), result.entries);
      button.dataset.cursor = result.cursor ? String(result.cursor) : "";
      button.hidden = !result.cursor;
    });

    function refreshActiveStudioView(viewId: WorkspaceViewId): void {
      if (viewId === "outline") void host.perform(() => outlineView.refresh());
      else if (viewId === "worldbook") void host.perform(() => worldbookView.refresh());
      else if (viewId === "deconstruct") void host.perform(() => deconstructView.refresh());
      else if (viewId === "techniques") void host.perform(() => techniqueView.refresh());
      else if (viewId === "io") ioView.refresh();
    }

    return {
      onDirectoryUpdated(isActiveProject, projectId, snapshot) {
        byId("tree-toolbar").hidden = !isActiveProject;
        if (!isActiveProject) {
          chaptersSelectKey = undefined;
          return;
        }
        chapterTitles = new Map((snapshot.documents ?? []).map((item) => [item.id, item.title]));
        if (settingProject !== projectId) {
          settingProject = projectId;
          byId<HTMLFormElement>("setting-proposal").reset();
          byId("setting-people").replaceChildren();
        }
        const nextSelectKey = `${projectId}:${(snapshot.documents ?? []).map((d) => `${d.id}:${d.title}`).join(",")}`;
        if (chaptersSelectKey !== nextSelectKey) {
          chaptersSelectKey = nextSelectKey;
          for (const select of byId("setting-proposal").querySelectorAll<HTMLSelectElement>("[data-setting-chapters]")) {
            populateSettingChapters(select);
          }
        }
        syncSettingExpiry();

        // Asynchronously upgrade left directory with 3-tier tree + word counts when volumes exist.
        const reqSeq = ++treeLoadSeq;
        void host.request<NovelTreeDto>("tree.get", { projectId })
          .then((tree) => {
            if (reqSeq !== treeLoadSeq || host.getState().projectId !== projectId) return;
            if (tree.volumes.length > 0 || tree.chapters.some((c) => c.charCount > 0)) {
              host.setDirectoryTree(tree);
            }
          })
          .catch(() => {
            // Keep flat list fallback cleanly if preview server or offline stub omits tree.
          });

        const currentView = host.getState().activeView;
        if (currentView !== "writing") refreshActiveStudioView(currentView);
      },

      onDocumentSelected() {
        byId("known-settings").replaceChildren();
      },

      onWorkspaceViewChanged(viewId) {
        refreshActiveStudioView(viewId);
      },

      renderDocumentSlots(isActiveProduct: boolean, snapshot: WorkspaceSnapshot) {
        const active = snapshot.active;
        byId("fanqie-actions").hidden = !isActiveProduct;
        byId("tab-continuity").hidden = !isActiveProduct;
        byId("chapter-outline").hidden = !isActiveProduct;
        byId("context-preview-root").hidden = !isActiveProduct;
        const pointWrap = byId("run-point");
        pointWrap.hidden = !isActiveProduct;
        const pointInput = byId<HTMLFormElement>("start-run").elements.namedItem("point") as HTMLInputElement;
        pointInput.disabled = !isActiveProduct;

        if (!isActiveProduct || !active) {
          planDocument = undefined;
          contextDoc = undefined;
          contextPreview.clear();
          return;
        }

        const hasDraft = Boolean(active.revisionId);
        const locked = active.state === "final";
        const { projectId } = host.getState();

        if (planDocument !== active.id) {
          planDocument = active.id;
          const outline = byId<HTMLFormElement>("chapter-outline");
          outline.reset();
          const plan = snapshot.planning ?? {};
          const flatPlan: Record<string, unknown> = { ...plan, ...(plan.sections ?? {}) };
          for (const [key, value] of Object.entries(flatPlan)) {
            const field = outline.elements.namedItem(key);
            if (
              (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
              (typeof value === "string" || typeof value === "number")
            ) {
              field.value = String(value);
            }
          }
        }

        if (contextDoc !== `${active.id}:${snapshot.asOfSeq ?? 0}`) {
          contextDoc = `${active.id}:${snapshot.asOfSeq ?? 0}`;
          void contextPreview.refresh();
        }

        const nextSettingsKey = JSON.stringify([projectId, snapshot.settings, snapshot.settingsCursor]);
        if (nextSettingsKey !== settingsKey) {
          settingsKey = nextSettingsKey;
          const settingList = byId("settings");
          settingList.replaceChildren();
          appendSettings(settingList, snapshot.settings ?? []);
          const moreBtn = byId<HTMLButtonElement>("settings-more");
          moreBtn.hidden = !snapshot.settingsCursor;
          moreBtn.dataset.cursor = snapshot.settingsCursor ? String(snapshot.settingsCursor) : "";
        }

        const position = (snapshot.documents ?? []).findIndex(({ id }) => id === active.id);
        byId<HTMLButtonElement>("move-up").disabled = position < 1;
        byId<HTMLButtonElement>("move-down").disabled = position >= (snapshot.documents?.length ?? 0) - 1;

        byId("reviews").textContent = `审稿打回 ${active.editorialRejections} / 2 次`;
        byId<HTMLButtonElement>("review-pass").disabled = !hasDraft || locked || active.state === "reviewed";
        byId<HTMLButtonElement>("review-reject").disabled = !hasDraft || locked || active.editorialRejections >= 2;
        byId<HTMLButtonElement>("finalize").disabled = active.state !== "reviewed";
      },

      validateRunStartParams(form) {
        const point = form.elements.namedItem("point") as HTMLInputElement;
        return point.reportValidity();
      },

      collectRunStartParams(form) {
        const point = form.elements.namedItem("point") as HTMLInputElement;
        return { point: Number(point.value || 1) };
      },
    };
  },
};
