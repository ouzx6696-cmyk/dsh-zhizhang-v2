import type {
  AiProposalDto,
  ChapterTreeItemDto,
  NovelTreeDto,
  ProjectControlsDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el, formatCharCount } from "../store.ts";

export interface OutlineBoardOptions {
  readonly getProviderModel?: () => { readonly provider: string; readonly model: string };
}

interface MoveOptionSpec {
  readonly value: string;
  readonly label: string;
}

const INITIAL_CHAPTER_PAGE = 8;
const CHAPTER_PAGE_STEP = 25;
const INITIAL_VOLUME_PAGE = 6;
const VOLUME_PAGE_STEP = 12;

function buildMoveOptionSpecs(tree: NovelTreeDto): MoveOptionSpec[] {
  const specs: MoveOptionSpec[] = [
    { value: "", label: "移动归属（卷 / 幕）…" },
    { value: "ungrouped:", label: "移至：未分卷" },
  ];
  const actsByVol = new Map<string, NovelTreeDto["acts"][number][]>();
  for (const act of tree.acts) {
    const list = actsByVol.get(act.volumeId);
    if (list) list.push(act);
    else actsByVol.set(act.volumeId, [act]);
  }
  for (const vol of tree.volumes) {
    specs.push({ value: `vol:${vol.id}`, label: `移至卷：${vol.title}` });
    for (const act of actsByVol.get(vol.id) ?? []) {
      specs.push({ value: `act:${vol.id}:${act.id}`, label: `移至幕：${vol.title} / ${act.title}` });
    }
  }
  return specs;
}

export function createOutlineBoardView(
  container: HTMLElement,
  host: WorkbenchShellHost,
  options?: OutlineBoardOptions,
) {
  let lastTree: NovelTreeDto | null = null;
  let summaryProposals: readonly AiProposalDto[] = [];
  let arcProposals: readonly AiProposalDto[] = [];
  let controls: ProjectControlsDto | null = null;
  let lastProjectId = "";
  let controlsExpanded = false;
  let expandedChapterId: string | null = null;
  let visibleVolumesLimit = INITIAL_VOLUME_PAGE;
  const expandedVolumes = new Set<string>();
  const chapterLimits = new Map<string, number>();

  function volumeLimit(sectionKey: string): number {
    return chapterLimits.get(sectionKey) ?? INITIAL_CHAPTER_PAGE;
  }

  async function refresh(): Promise<void> {
    const { projectId, documentId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    if (!project || project.product !== "fanqie") {
      container.replaceChildren(el("p", "请选择番茄连载项目以管理卷幕章三级目录。", "muted-copy"));
      return;
    }

    if (lastProjectId !== projectId) {
      lastProjectId = projectId;
      expandedVolumes.clear();
      chapterLimits.clear();
      expandedChapterId = null;
      visibleVolumesLimit = INITIAL_VOLUME_PAGE;
      controlsExpanded = false;
    }

    const [tree, sumProps, arcProps, projControls] = await Promise.all([
      host.request<NovelTreeDto>("tree.get", { projectId }),
      host.request<AiProposalDto[]>("proposal.list", { projectId, kind: "summary", status: "pending" }),
      host.request<AiProposalDto[]>("proposal.list", { projectId, kind: "arc_plan", status: "pending" }).catch(() => []),
      host.request<ProjectControlsDto>("controls.get", { projectId }).catch(() => null),
    ]);

    lastTree = tree;
    summaryProposals = sumProps;
    arcProposals = arcProps;
    controls = projControls;

    if (expandedVolumes.size === 0 && tree.volumes.length > 0) {
      const activeCh = documentId ? tree.chapters.find((c) => c.id === documentId) : undefined;
      expandedVolumes.add(activeCh?.volumeId ?? tree.volumes[0].id);
    }

    paint();
  }

  function paint(): void {
    const tree = lastTree;
    if (!tree) return;
    const { projectId } = host.getState();
    const moveSpecs = buildMoveOptionSpecs(tree);
    container.replaceChildren();

    const header = el("header", "", "view-header");
    const titleWrap = el("div");
    titleWrap.append(
      el("p", "长篇小说三级大纲与进度矩阵", "eyebrow"),
      el("h1", `共 ${tree.volumes.length} 卷 · ${tree.acts.length} 幕 · ${tree.chapters.length} 章 · ${formatCharCount(tree.totalChars)}`),
    );
    const headerControls = el("div", "", "actions");
    const addVolBtn = el("button", "+ 新建卷", "primary");
    addVolBtn.type = "button";
    addVolBtn.onclick = () =>
      void host.perform(async () => {
        const title = await host.modal.prompt({
          title: "新建卷",
          message: "输入卷名，例如：第一卷 · 潜龙出渊",
          label: "卷标题",
          confirmLabel: "创建卷",
        });
        if (!title?.trim()) return;
        await host.request("volume.create", { projectId, title: title.trim() });
        await refresh();
        await host.load();
      });

    const addChapterBtn = el("button", "+ 新建章节");
    addChapterBtn.type = "button";
    addChapterBtn.onclick = () =>
      void host.perform(async () => {
        const title = await host.modal.prompt({
          title: "新建章节",
          message: "输入章节标题：",
          label: "章名",
          confirmLabel: "创建章节",
        });
        if (!title?.trim()) return;
        const created = await host.request<{ id: string }>("document.create", {
          projectId,
          title: title.trim(),
          volumeId: [...expandedVolumes][0] ?? tree.volumes[0]?.id ?? null,
        });
        await host.selectDocument(created.id);
        await refresh();
      });

    headerControls.append(addVolBtn, addChapterBtn);
    header.append(titleWrap, headerControls);
    container.append(header);

    // Compass Control Plane (authorIntent + currentFocus) — collapsed by default for minimal DOM
    const compassCard = el("section", "", "panel-card");
    const compassHead = el("div", "", "outline-chapter-top");
    compassHead.append(el("h2", "全书指南针与当前写作焦点"));
    const compassToggle = el("button", controlsExpanded ? "收起" : "编辑控制面");
    compassToggle.type = "button";
    compassToggle.onclick = () => {
      controlsExpanded = !controlsExpanded;
      paint();
    };
    compassHead.append(compassToggle);
    compassCard.append(compassHead);

    if (controlsExpanded) {
      const form = el("div", "", "stack-form");
      const intentInput = document.createElement("textarea");
      intentInput.rows = 3;
      intentInput.placeholder = "全书指南针（注入 Prefix 稳定区）：终局方向、核心卖点、活跃长线、明确禁区…";
      intentInput.value = controls?.authorIntent ?? "";

      const focusInput = document.createElement("textarea");
      focusInput.rows = 2;
      focusInput.placeholder = "当前焦点（注入动态尾区）：近 1–3 章主矛盾与情绪节奏…";
      focusInput.value = controls?.currentFocus ?? "";

      const saveCtrlBtn = el("button", "保存控制面", "primary");
      saveCtrlBtn.type = "button";
      saveCtrlBtn.onclick = () =>
        void host.perform(async () => {
          controls = await host.request<ProjectControlsDto>("controls.save", {
            projectId,
            authorIntent: intentInput.value,
            currentFocus: focusInput.value,
          });
          host.notice("全书指南针与当前焦点已保存");
          controlsExpanded = false;
          paint();
        });
      form.append(intentInput, focusInput, saveCtrlBtn);
      compassCard.append(form);
    } else if (controls?.authorIntent || controls?.currentFocus) {
      compassCard.append(
        el(
          "p",
          [
            controls.authorIntent ? `指南针：${controls.authorIntent.slice(0, 48)}` : "",
            controls.currentFocus ? `焦点：${controls.currentFocus.slice(0, 48)}` : "",
          ].filter(Boolean).join(" · "),
          "muted-copy",
        ),
      );
    }
    container.append(compassCard);

    if (arcProposals.length > 0 || summaryProposals.length > 0) {
      const propSection = el("section", "", "panel-card");
      propSection.append(el("h2", `待确认 AI 规划与摘要提案（${arcProposals.length + summaryProposals.length}）`));
      for (const prop of arcProposals) {
        const row = el("div", "", "proposal-row");
        const actSummary = typeof prop.payload.actSummary === "string" ? prop.payload.actSummary : "";
        const nextTitle = typeof prop.payload.nextActTitle === "string" ? prop.payload.nextActTitle : "";
        row.append(el("p", `滚动幕规划「${prop.sourceRef || "当前幕"}」：${[actSummary, nextTitle && `下一幕：${nextTitle}`].filter(Boolean).join(" → ")}`));
        const actions = el("div", "", "actions");
        const acceptBtn = el("button", "确认应用规划", "primary");
        acceptBtn.type = "button";
        acceptBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: true });
            await refresh();
          });
        const rejectBtn = el("button", "拒绝");
        rejectBtn.type = "button";
        rejectBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: false });
            await refresh();
          });
        actions.append(acceptBtn, rejectBtn);
        row.append(actions);
        propSection.append(row);
      }
      for (const prop of summaryProposals) {
        const row = el("div", "", "proposal-row");
        const summaryText = typeof prop.payload.summary === "string" ? prop.payload.summary : "";
        row.append(el("p", `${prop.sourceRef || prop.documentId || "章节"}：${summaryText}`));
        const actions = el("div", "", "actions");
        const acceptBtn = el("button", "确认写入摘要", "primary");
        acceptBtn.type = "button";
        acceptBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: true });
            await refresh();
          });
        const rejectBtn = el("button", "拒绝");
        rejectBtn.type = "button";
        rejectBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: false });
            await refresh();
          });
        actions.append(acceptBtn, rejectBtn);
        row.append(actions);
        propSection.append(row);
      }
      container.append(propSection);
    }

    // Group chapters & acts in single O(N) pass to keep 5,000-chapter paints fast
    const chaptersByVol = new Map<string, ChapterTreeItemDto[]>();
    const charsByVol = new Map<string, number>();
    const ungrouped: ChapterTreeItemDto[] = [];
    for (const ch of tree.chapters) {
      if (!ch.volumeId) {
        ungrouped.push(ch);
        continue;
      }
      const list = chaptersByVol.get(ch.volumeId);
      if (list) list.push(ch);
      else chaptersByVol.set(ch.volumeId, [ch]);
      charsByVol.set(ch.volumeId, (charsByVol.get(ch.volumeId) ?? 0) + ch.charCount);
    }
    const actsByVol = new Map<string, NovelTreeDto["acts"][number][]>();
    for (const act of tree.acts) {
      const list = actsByVol.get(act.volumeId);
      if (list) list.push(act);
      else actsByVol.set(act.volumeId, [act]);
    }
    const actTitleById = new Map(tree.acts.map((a) => [a.id, a]));

    function renderChapterRow(ch: ChapterTreeItemDto): HTMLElement {
      const isExpanded = expandedChapterId === ch.id;
      const card = el("article", "", isExpanded ? "outline-chapter-card" : "outline-chapter-row");

      if (!isExpanded) {
        const openBtn = el("button", `#${ch.order} ${ch.title}`, "link-btn");
        openBtn.type = "button";
        openBtn.onclick = () => void host.perform(() => host.selectDocument(ch.id));

        const actLabel = ch.actId ? actTitleById.get(ch.actId)?.title : "";
        const summaryHint = ch.summary ? ` · ${ch.summary.slice(0, 32)}` : "";
        const meta = el(
          "span",
          `${actLabel ? `[${actLabel}] ` : ""}${ch.state} · ${ch.charCount} 字${summaryHint}`,
          "muted-copy tabular",
        );

        const editBtn = el("button", "展开编辑");
        editBtn.type = "button";
        editBtn.onclick = () => {
          expandedChapterId = ch.id;
          paint();
        };
        card.append(openBtn, meta, editBtn);
        return card;
      }

      const top = el("div", "", "outline-chapter-top");
      const openBtn = el("button", `#${ch.order} ${ch.title}`, "link-btn");
      openBtn.type = "button";
      openBtn.onclick = () => void host.perform(() => host.selectDocument(ch.id));
      const collapseBtn = el("button", "收起");
      collapseBtn.type = "button";
      collapseBtn.onclick = () => {
        expandedChapterId = null;
        paint();
      };
      top.append(openBtn, collapseBtn);

      const summaryInput = document.createElement("textarea");
      summaryInput.rows = 2;
      summaryInput.placeholder = "本章滚动摘要（供后续章节写作自动注入前文上下文）…";
      summaryInput.value = ch.summary;

      const rowActions = el("div", "", "actions");
      const saveSummaryBtn = el("button", "保存摘要", "primary");
      saveSummaryBtn.type = "button";
      saveSummaryBtn.onclick = () =>
        void host.perform(async () => {
          await host.request("chapter.summary.save", { documentId: ch.id, summary: summaryInput.value });
          host.notice("章节滚动摘要已保存");
          await refresh();
        });

      const moveSelect = document.createElement("select");
      moveSelect.className = "inline-select";
      for (const spec of moveSpecs) {
        moveSelect.append(new Option(spec.label, spec.value));
      }
      moveSelect.onchange = () => {
        const val = moveSelect.value;
        if (!val) return;
        moveSelect.value = "";
        void host.perform(async () => {
          const [kind, volId, actId] = val.split(":");
          const payload =
            kind === "ungrouped"
              ? { documentId: ch.id, targetVolumeId: null, targetActId: null }
              : kind === "vol"
                ? { documentId: ch.id, targetVolumeId: volId, targetActId: null }
                : { documentId: ch.id, targetVolumeId: volId, targetActId: actId };
          const plan = await host.request<{
            impact: readonly { id: string; relations: readonly { label: string }[] }[];
            requiresAuthorConfirmation: boolean;
            asOfSeq: number;
          }>("chapter.move", { ...payload, preview: true });
          const details = plan.impact.flatMap((item) => item.relations.map((r) => `${item.id} · ${r.label} 时序将翻转`));
          if (plan.requiresAuthorConfirmation) {
            const ok = await host.modal.confirm({
              title: "确认跨卷幕移动章节",
              message: "本次移动将翻转以下已确认设定的时间先后关系：",
              details,
              confirmLabel: "确认移动",
            });
            if (!ok) return;
          }
          await host.request("chapter.move", { ...payload, asOfSeq: plan.asOfSeq, confirmed: true });
          host.notice("章节位置与目录树已更新");
          await refresh();
          await host.load();
        });
      };

      rowActions.append(saveSummaryBtn, moveSelect);
      card.append(top, summaryInput, rowActions);
      return card;
    }

    const volumesToShow = tree.volumes.slice(0, visibleVolumesLimit);
    for (const vol of volumesToShow) {
      const volChapters = chaptersByVol.get(vol.id) ?? [];
      const volChars = charsByVol.get(vol.id) ?? 0;
      const isExpanded = expandedVolumes.has(vol.id);
      const volSection = el("section", "", "panel-card volume-card");
      const volHead = el("div", "", "outline-chapter-top");

      const volToggle = el("button", `${isExpanded ? "▾" : "▸"} ${vol.title}（${volChapters.length} 章 · ${formatCharCount(volChars)}）`, "link-btn");
      volToggle.type = "button";
      volToggle.onclick = () => {
        if (expandedVolumes.has(vol.id)) expandedVolumes.delete(vol.id);
        else expandedVolumes.add(vol.id);
        paint();
      };
      volHead.append(volToggle);

      if (!isExpanded) {
        volSection.append(volHead);
        container.append(volSection);
        continue;
      }

      const volBtns = el("div", "", "actions");
      const addActBtn = el("button", "+ 新建幕");
      addActBtn.type = "button";
      addActBtn.onclick = () =>
        void host.perform(async () => {
          const title = await host.modal.prompt({
            title: `在「${vol.title}」新建幕`,
            message: "输入幕标题（例如：第一幕 · 退婚风波）：",
            label: "幕标题",
            confirmLabel: "创建幕",
          });
          if (!title?.trim()) return;
          await host.request("act.create", { projectId, volumeId: vol.id, title: title.trim() });
          await refresh();
        });

      const rollPlanBtn = el("button", "滚动规划下一幕");
      rollPlanBtn.type = "button";
      rollPlanBtn.onclick = () =>
        void host.perform(async () => {
          const volActs = actsByVol.get(vol.id) ?? [];
          const latestAct = volActs[volActs.length - 1];
          const pm = options?.getProviderModel?.() ?? { provider: "deepseek-account", model: "deepseek-flash" };
          await host.request("proposal.generate", {
            kind: "arc_plan",
            projectId,
            volumeId: vol.id,
            ...(latestAct ? { actId: latestAct.id } : {}),
            provider: pm.provider,
            model: pm.model,
          });
          host.notice("已提交滚动幕规划提案，请确认后创建下一幕");
          await refresh();
        });

      const delVolBtn = el("button", "删空卷", "danger");
      delVolBtn.type = "button";
      delVolBtn.onclick = () =>
        void host.perform(async () => {
          await host.request("volume.delete", { projectId, volumeId: vol.id });
          await refresh();
        });
      volBtns.append(addActBtn, rollPlanBtn, delVolBtn);
      volHead.append(volBtns);
      volSection.append(volHead);

      const volActs = actsByVol.get(vol.id) ?? [];
      if (volActs.length > 0) {
        const actsMeta = volActs
          .slice(0, 3)
          .map((a) => `${a.title}${a.arcGoal || a.goal ? `(${(a.arcGoal || a.goal).slice(0, 16)})` : ""}`)
          .join(" · ");
        volSection.append(el("p", `已建 ${volActs.length} 幕：${actsMeta}${volActs.length > 3 ? " …" : ""}`, "muted-copy"));
      }

      const limit = volumeLimit(vol.id);
      const visibleChapters = volChapters.slice(0, limit);
      for (const ch of visibleChapters) {
        volSection.append(renderChapterRow(ch));
      }
      if (volChapters.length > visibleChapters.length) {
        const moreBtn = el(
          "button",
          `加载更多章节（已显示 ${visibleChapters.length} / ${volChapters.length}）`,
        );
        moreBtn.type = "button";
        moreBtn.onclick = () => {
          chapterLimits.set(vol.id, limit + CHAPTER_PAGE_STEP);
          paint();
        };
        volSection.append(moreBtn);
      }
      container.append(volSection);
    }

    if (tree.volumes.length > volumesToShow.length) {
      const moreVolsBtn = el(
        "button",
        `显示更多卷（剩余 ${tree.volumes.length - volumesToShow.length} 卷）`,
      );
      moreVolsBtn.type = "button";
      moreVolsBtn.onclick = () => {
        visibleVolumesLimit += VOLUME_PAGE_STEP;
        paint();
      };
      container.append(moreVolsBtn);
    }

    if (ungrouped.length > 0) {
      const misc = el("section", "", "panel-card");
      misc.append(el("h2", `未分卷章节（${ungrouped.length}）`));
      const limit = volumeLimit("__ungrouped__");
      const visible = ungrouped.slice(0, limit);
      for (const ch of visible) misc.append(renderChapterRow(ch));
      if (ungrouped.length > visible.length) {
        const moreBtn = el("button", `加载更多未分卷章节（已显示 ${visible.length} / ${ungrouped.length}）`);
        moreBtn.type = "button";
        moreBtn.onclick = () => {
          chapterLimits.set("__ungrouped__", limit + CHAPTER_PAGE_STEP);
          paint();
        };
        misc.append(moreBtn);
      }
      container.append(misc);
    }
  }

  return { refresh };
}
