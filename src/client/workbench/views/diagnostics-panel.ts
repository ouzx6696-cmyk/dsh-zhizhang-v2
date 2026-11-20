import type {
  AiProposalDto,
  ChapterDiagnosticsReportDto,
  ChapterObservationDto,
  SlopConfigDto,
} from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";

export interface DiagnosticsPanelOptions {
  readonly getProviderModel: () => { readonly provider: string; readonly model: string };
  readonly getRunDefaults: () => { readonly point: number; readonly tokenLimit: number };
}

const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  continuity: "连续性",
  ooc: "人设 OOC",
  pacing: "节奏卡点",
  foreshadow: "伏笔照应",
  style: "文风语气",
  ai_slop: "AI 味",
};

/**
 * Fanqie chapter quality control & observation-driven revision panel:
 * offline Golden-3-chapters + AI-slop diagnostics, qualitative review proposals,
 * and checkbox-selected targeted revision runs.
 */
export function createDiagnosticsPanel(
  container: HTMLElement,
  host: WorkbenchShellHost,
  options: DiagnosticsPanelOptions,
) {
  let activeDocId = "";
  let activeProjectId = "";
  let report: ChapterDiagnosticsReportDto | null = null;
  let observations: readonly ChapterObservationDto[] = [];
  let pendingReviews: readonly AiProposalDto[] = [];
  const selectedIds = new Set<string>();

  const root = el("section", { className: "diagnostics-panel" });
  root.hidden = true;
  container.replaceChildren(root);

  function paint(): void {
    if (!activeDocId) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    root.hidden = false;
    root.replaceChildren();

    root.append(el("h3", { className: "sub-heading", text: "章节诊断与定性审稿观察" }));

    const toolbar = el("div", { className: "actions" });
    const diagBtn = el("button", { text: "离线体检" });
    diagBtn.type = "button";
    diagBtn.onclick = () =>
      void host.perform(async () => {
        report = await host.request<ChapterDiagnosticsReportDto>("chapter.diagnose", {
          documentId: activeDocId,
        });
        host.notice("已完成离线体检（零 Token）");
        paint();
      });

    const slopBtn = el("button", { text: "禁用/白名单" });
    slopBtn.type = "button";
    slopBtn.onclick = () =>
      void host.perform(async () => {
        if (!activeProjectId) return;
        const current = await host.request<SlopConfigDto>("slop.config.get", { projectId: activeProjectId });
        const customRaw = await host.modal.prompt({
          title: "AI 味自定义禁用词（项目级）",
          message: "输入本书额外的机械禁用词，每行或用逗号分隔。",
          label: "自定义禁用词",
          initialValue: current.customBanned.join("\n"),
          confirmLabel: "下一步：白名单",
        });
        if (customRaw === null) return;
        const whiteRaw = await host.modal.prompt({
          title: "AI 味豁免白名单（项目级）",
          message: "输入允许保留不报警告的词汇或句式（例如主角口头禅）。",
          label: "白名单词汇",
          initialValue: current.whitelist.join("\n"),
          confirmLabel: "保存词库配置",
        });
        if (whiteRaw === null) return;
        const splitTerms = (raw: string) =>
          raw.split(/[\r\n,，、]+/u).map((s) => s.trim()).filter(Boolean);
        await host.request("slop.config.save", {
          projectId: activeProjectId,
          customBanned: splitTerms(customRaw),
          whitelist: splitTerms(whiteRaw),
        });
        host.notice("已更新本书 AI 味禁用词与白名单");
        if (report) {
          report = await host.request<ChapterDiagnosticsReportDto>("chapter.diagnose", { documentId: activeDocId });
          paint();
        }
      });

    const reviewBtn = el("button", { className: "primary", text: "AI 定性审稿" });
    reviewBtn.type = "button";
    reviewBtn.onclick = () =>
      void host.perform(async () => {
        const { provider, model } = options.getProviderModel();
        await host.request("proposal.generate", {
          kind: "chapter_review",
          projectId: activeProjectId || undefined,
          documentId: activeDocId,
          provider,
          model,
        });
        host.notice("已提交定性审稿提案，请在下方或收件箱确认录入");
        await refreshForDocument(activeDocId, activeProjectId);
      });

    toolbar.append(diagBtn, slopBtn, reviewBtn);
    root.append(toolbar);

    if (report) {
      const box = el("div", { className: "diag-score-row" });
      if (report.goldenThree.isGoldenThreeChapter) {
        box.append(
          el("p", {
            className: "setting-title",
            text: `黄金三章离线总分：${report.goldenThree.overallScore} / 100`,
          }),
          el("p", {
            className: "setting-meta",
            text: report.goldenThree.dimensions
              .map((d) => `${d.label}:${d.score}(${d.status === "pass" ? "达标" : "需关注"})`)
              .join(" · "),
          }),
        );
      }
      box.append(
        el("p", {
          className: report.aiSlop.severity === "clean" ? "setting-meta" : "status-warning",
          text: `AI 味密度：${report.aiSlop.densityPer1000Chars} 次/千字（共命中 ${report.aiSlop.totalHits} 处）${
            report.aiSlop.topPhrases.length > 0
              ? ` · 高频：${report.aiSlop.topPhrases.slice(0, 4).map((p) => `${p.phrase}×${p.count}`).join("、")}`
              : ""
          }`,
        }),
      );
      root.append(box);
    }

    if (pendingReviews.length > 0) {
      for (const prop of pendingReviews) {
        const row = el("div", { className: "obs-item" });
        const countHint = Array.isArray(prop.payload.observations)
          ? `含 ${prop.payload.observations.length} 条举证观察`
          : "定性审稿提案";
        row.append(el("p", { className: "setting-meta", text: `待确认审稿提案：${countHint}` }));
        const acceptBtn = el("button", { className: "primary", text: "确认录入观察" });
        acceptBtn.type = "button";
        acceptBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: true });
            host.notice("已将定性观察录入本章列表");
            await refreshForDocument(activeDocId, activeProjectId);
          });
        row.append(acceptBtn);
        root.append(row);
      }
    }

    if (observations.length > 0) {
      root.append(el("p", { className: "setting-title", text: `待处理观察条目（${observations.length}）` }));
      for (const obs of observations) {
        const card = el("div", { className: "obs-item" });
        const head = el("label", { className: "diff-check-label" });
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selectedIds.has(obs.id);
        cb.onchange = () => {
          if (cb.checked) selectedIds.add(obs.id);
          else selectedIds.delete(obs.id);
        };
        head.append(
          cb,
          document.createTextNode(` [${DIMENSION_LABELS[obs.dimension] ?? obs.dimension} · ${obs.severity}]`),
        );
        card.append(head);
        if (obs.quote) {
          card.append(el("p", { className: "setting-meta", text: `摘句：「${obs.quote}」` }));
        }
        card.append(el("p", { text: obs.suggestion }));

        const rowActions = el("div", { className: "actions" });
        for (const [status, label] of [["addressed", "已处理"], ["dismissed", "忽略"]] as const) {
          const btn = el("button", { text: label });
          btn.type = "button";
          btn.onclick = () =>
            void host.perform(async () => {
              await host.request("observation.update", { observationId: obs.id, status });
              selectedIds.delete(obs.id);
              await refreshForDocument(activeDocId, activeProjectId);
            });
          rowActions.append(btn);
        }
        card.append(rowActions);
        root.append(card);
      }

      const targetedBtn = el("button", { className: "primary", text: "按勾选条目定向修稿" });
      targetedBtn.type = "button";
      targetedBtn.onclick = () =>
        void host.perform(async () => {
          const ids = [...selectedIds].filter((id) => observations.some((o) => o.id === id));
          if (ids.length === 0) {
            throw new Error("请先勾选至少一条观察建议。");
          }
          const defaults = options.getRunDefaults();
          await host.change(
            "run.start",
            {
              observationIds: ids,
              instruction: `仅针对勾选的 ${ids.length} 条审稿观察做外科手术式局部精修，尽量保留原章其余段落`,
              point: defaults.point,
              tokenLimit: defaults.tokenLimit,
            },
            { savedVersion: true, message: `已创建基于 ${ids.length} 条观察的定向修稿任务` },
          );
          host.switchPipelineTab("runs");
        });
      root.append(targetedBtn);
    }
  }

  async function refreshForDocument(documentId: string, projectId: string): Promise<void> {
    if (!documentId) {
      clear();
      return;
    }
    const switchedDoc = documentId !== activeDocId;
    activeDocId = documentId;
    activeProjectId = projectId;
    if (switchedDoc) {
      report = null;
      selectedIds.clear();
    }
    try {
      const [obsList, props] = await Promise.all([
        host.request<readonly ChapterObservationDto[]>("observation.list", {
          documentId,
          status: "open",
        }),
        host.request<readonly AiProposalDto[]>("proposal.list", {
          ...(projectId ? { projectId } : {}),
          kind: "chapter_review",
          status: "pending",
        }),
      ]);
      if (activeDocId !== documentId) return;
      observations = obsList;
      pendingReviews = props.filter((p) => !p.documentId || p.documentId === documentId);
      for (const id of [...selectedIds]) {
        if (!observations.some((o) => o.id === id)) selectedIds.delete(id);
      }
      if (switchedDoc) {
        for (const o of observations) selectedIds.add(o.id);
      }
    } catch {
      if (activeDocId !== documentId) return;
      observations = [];
      pendingReviews = [];
    }
    paint();
  }

  function clear(): void {
    activeDocId = "";
    activeProjectId = "";
    report = null;
    observations = [];
    pendingReviews = [];
    selectedIds.clear();
    paint();
  }

  return { refreshForDocument, clear };
}
