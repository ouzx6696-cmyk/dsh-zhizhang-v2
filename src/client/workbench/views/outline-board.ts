import type { AiProposalDto, NovelTreeDto } from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el, formatCharCount } from "../store.ts";

export function createOutlineBoardView(container: HTMLElement, host: WorkbenchShellHost) {
  let lastTree: NovelTreeDto | null = null;
  let summaryProposals: readonly AiProposalDto[] = [];

  async function refresh(): Promise<void> {
    const { projectId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    if (!project || project.product !== "fanqie") {
      container.replaceChildren(el("p", "请选择番茄连载项目以管理卷幕章三级目录。", "muted-copy"));
      return;
    }
    const [tree, proposals] = await Promise.all([
      host.request<NovelTreeDto>("tree.get", { projectId }),
      host.request<AiProposalDto[]>("proposal.list", { projectId, kind: "summary", status: "pending" }),
    ]);
    lastTree = tree;
    summaryProposals = proposals;
    paint();
  }

  function paint(): void {
    const tree = lastTree;
    if (!tree) return;
    const { projectId } = host.getState();
    container.replaceChildren();

    const header = el("header", "", "view-header");
    const titleWrap = el("div");
    titleWrap.append(
      el("p", "长篇小说三级大纲与进度矩阵", "eyebrow"),
      el("h1", `共 ${tree.volumes.length} 卷 · ${tree.acts.length} 幕 · ${tree.chapters.length} 章 · ${formatCharCount(tree.totalChars)}`),
    );
    const controls = el("div", "", "actions");
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
          volumeId: tree.volumes[0]?.id ?? null,
        });
        await host.selectDocument(created.id);
        await refresh();
      });

    controls.append(addVolBtn, addChapterBtn);
    header.append(titleWrap, controls);
    container.append(header);

    if (summaryProposals.length > 0) {
      const propSection = el("section", "", "panel-card");
      propSection.append(el("h2", `待确认 AI 章节摘要提案（${summaryProposals.length}）`));
      for (const prop of summaryProposals) {
        const row = el("div", "", "proposal-row");
        const summaryText = typeof prop.payload.summary === "string" ? prop.payload.summary : "";
        row.append(
          el("p", `${prop.sourceRef || prop.documentId || "章节"}：${summaryText}`),
        );
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

    const renderChapterRow = (ch: NovelTreeDto["chapters"][number]) => {
      const card = el("article", "", "outline-chapter-card");
      const top = el("div", "", "outline-chapter-top");
      const openBtn = el("button", `#${ch.order} ${ch.title}`, "link-btn");
      openBtn.type = "button";
      openBtn.onclick = () => void host.perform(() => host.selectDocument(ch.id));

      const targetHint = ch.targetLength ? ` / 目标 ${ch.targetLength}` : "";
      const meta = el("span", `${ch.state} · ${ch.charCount} 字${targetHint}${ch.viewpoint ? ` · 视角 ${ch.viewpoint}` : ""}`, "muted-copy tabular");
      top.append(openBtn, meta);

      const summaryInput = document.createElement("textarea");
      summaryInput.rows = 2;
      summaryInput.placeholder = "本章滚动摘要（供后续章节写作自动注入前文上下文）…";
      summaryInput.value = ch.summary;

      const rowActions = el("div", "", "actions");
      const saveSummaryBtn = el("button", "保存摘要");
      saveSummaryBtn.type = "button";
      saveSummaryBtn.onclick = () =>
        void host.perform(async () => {
          await host.request("chapter.summary.save", { documentId: ch.id, summary: summaryInput.value });
          host.notice("章节滚动摘要已保存");
          await refresh();
        });

      const moveSelect = document.createElement("select");
      moveSelect.className = "inline-select";
      moveSelect.append(new Option("移动归属（卷 / 幕）…", ""));
      moveSelect.append(new Option("移至：未分卷", "ungrouped:"));
      for (const vol of tree.volumes) {
        moveSelect.append(new Option(`移至卷：${vol.title}`, `vol:${vol.id}`));
        for (const act of tree.acts.filter((a) => a.volumeId === vol.id)) {
          moveSelect.append(new Option(`移至幕：${vol.title} / ${act.title}`, `act:${vol.id}:${act.id}`));
        }
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
    };

    for (const vol of tree.volumes) {
      const volChapters = tree.chapters.filter((ch) => ch.volumeId === vol.id);
      const volChars = volChapters.reduce((sum, ch) => sum + ch.charCount, 0);
      const volSection = el("section", "", "panel-card volume-card");
      const volHead = el("div", "", "outline-chapter-top");
      volHead.append(el("h2", `${vol.title}（${volChapters.length} 章 · ${formatCharCount(volChars)}）`));

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
      const delVolBtn = el("button", "删空卷", "danger");
      delVolBtn.type = "button";
      delVolBtn.onclick = () =>
        void host.perform(async () => {
          await host.request("volume.delete", { projectId, volumeId: vol.id });
          await refresh();
        });
      volBtns.append(addActBtn, delVolBtn);
      volHead.append(volBtns);
      volSection.append(volHead);

      const volActs = tree.acts.filter((a) => a.volumeId === vol.id);
      for (const act of volActs) {
        const actChapters = volChapters.filter((ch) => ch.actId === act.id);
        const actBox = el("div", "", "act-card");
        actBox.append(el("h3", `${act.title}（${actChapters.length} 章）`, "sub-heading"));
        for (const ch of actChapters) actBox.append(renderChapterRow(ch));
        volSection.append(actBox);
      }

      const direct = volChapters.filter((ch) => !ch.actId);
      for (const ch of direct) volSection.append(renderChapterRow(ch));
      container.append(volSection);
    }

    const ungrouped = tree.chapters.filter((ch) => !ch.volumeId);
    if (ungrouped.length > 0) {
      const misc = el("section", "", "panel-card");
      misc.append(el("h2", `未分卷章节（${ungrouped.length}）`));
      for (const ch of ungrouped) misc.append(renderChapterRow(ch));
      container.append(misc);
    }
  }

  return { refresh };
}
