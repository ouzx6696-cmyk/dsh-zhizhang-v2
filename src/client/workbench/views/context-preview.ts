import type {
  ContextAssemblyReportDto,
  ContextTuningConfigDto,
  TechniqueRecommendationDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton, createInput } from "../ui/primitives.ts";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  included: "完整注入",
  truncated: "配额裁剪",
  dropped: "预算略过",
  empty: "无内容",
  disabled: "已关闭",
};

const TIER_TAGS: Readonly<Record<string, string>> = {
  l1: "[L1] ",
  l2: "[L2] ",
  l3: "[L3] ",
};

const FALLBACK_DEFAULT_TUNING: ContextTuningConfigDto = {
  defaultTokenLimit: 16_000,
  inputBudgetRatio: 0.72,
  l1BudgetTokens: 8_192,
  l1DirtyThreshold: 10,
  l2MilestoneChunkSize: 10,
  prevTailChars: 1_200,
  rollingSummaryCount: 9,
  relatedHistoryTopK: 4,
  relatedHistoryRecentExclude: 5,
  antiEchoWindow: 3,
  staleForeshadowGap: 20,
  includeL1BookBible: true,
  includeL2VolumeMilestones: true,
  includePovBoundary: true,
  includeDueForeshadows: true,
  includeAntiEchoGuard: true,
  includeTechniques: true,
  includeDeconstructions: true,
  includeCurrentFocus: true,
  includeRelatedHistory: true,
  includeRollingSummaries: true,
  includePrevTail: true,
  maxActiveTechniques: 3,
  maxActiveDeconstructions: 2,
  techniqueExampleChars: 400,
  deconstructionExcerptChars: 600,
};

interface NumericFieldSpec {
  readonly key:
    | "defaultTokenLimit"
    | "inputBudgetRatio"
    | "l1BudgetTokens"
    | "l1DirtyThreshold"
    | "l2MilestoneChunkSize"
    | "prevTailChars"
    | "rollingSummaryCount"
    | "relatedHistoryTopK"
    | "relatedHistoryRecentExclude"
    | "antiEchoWindow"
    | "staleForeshadowGap"
    | "maxActiveTechniques"
    | "maxActiveDeconstructions"
    | "techniqueExampleChars"
    | "deconstructionExcerptChars";
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly hint: string;
}

interface ToggleFieldSpec {
  readonly key:
    | "includeL1BookBible"
    | "includeL2VolumeMilestones"
    | "includePovBoundary"
    | "includeDueForeshadows"
    | "includeAntiEchoGuard"
    | "includeTechniques"
    | "includeDeconstructions"
    | "includeCurrentFocus"
    | "includeRelatedHistory"
    | "includeRollingSummaries"
    | "includePrevTail";
  readonly tier: "L1" | "L2" | "L3";
  readonly label: string;
  readonly note?: string;
}

const LENGTH_FIELDS: readonly NumericFieldSpec[] = [
  { key: "defaultTokenLimit", label: "默认总预算 (token)", min: 4000, max: 128000, step: 1000, hint: "默认 16000" },
  { key: "inputBudgetRatio", label: "输入配额占比", min: 0.5, max: 0.9, step: 0.02, hint: "默认 0.72" },
  { key: "l1BudgetTokens", label: "L1 圣经快照配额", min: 1024, max: 32768, step: 512, hint: "默认 8192" },
  { key: "l1DirtyThreshold", label: "L1 自动重建阈值", min: 1, max: 50, step: 1, hint: "默认 10 次变更" },
  { key: "l2MilestoneChunkSize", label: "L2 里程碑步长 (章)", min: 5, max: 30, step: 1, hint: "默认 10 章" },
];

const READING_FIELDS: readonly NumericFieldSpec[] = [
  { key: "prevTailChars", label: "上章末尾衔接字数", min: 0, max: 6000, step: 100, hint: "默认 1200（0=不读）" },
  { key: "rollingSummaryCount", label: "近期滚动摘要章数", min: 0, max: 30, step: 1, hint: "默认 9 章" },
  { key: "relatedHistoryTopK", label: "远期相关章召回条数", min: 0, max: 12, step: 1, hint: "默认 Top 4" },
  { key: "relatedHistoryRecentExclude", label: "远期排除近章数", min: 1, max: 20, step: 1, hint: "默认近 5 章" },
  { key: "antiEchoWindow", label: "防复读扫描回看章数", min: 0, max: 10, step: 1, hint: "默认近 3 章" },
  { key: "staleForeshadowGap", label: "超期伏笔预警间隔", min: 5, max: 100, step: 1, hint: "默认 20 章" },
];

const LIBRARY_CAP_FIELDS: readonly NumericFieldSpec[] = [
  { key: "maxActiveTechniques", label: "单章最多技法卡数", min: 0, max: 10, step: 1, hint: "默认 3 张" },
  { key: "maxActiveDeconstructions", label: "单章最多拆书范本数", min: 0, max: 6, step: 1, hint: "默认 2 份" },
  { key: "techniqueExampleChars", label: "技法正/反例截断字数", min: 100, max: 1200, step: 50, hint: "默认 400 字" },
  { key: "deconstructionExcerptChars", label: "拆书节选截断字数", min: 150, max: 2000, step: 50, hint: "默认 600 字" },
];

const SLOT_TOGGLES: readonly ToggleFieldSpec[] = [
  { key: "includeL1BookBible", tier: "L1", label: "全书设定圣经快照" },
  { key: "includeL2VolumeMilestones", tier: "L2", label: "卷幕与里程碑账本" },
  { key: "includePovBoundary", tier: "L3", label: "视角知情边界与声线锚点", note: "关闭仅用于全知视角实验，可能降低防剧透隔离" },
  { key: "includeDueForeshadows", tier: "L3", label: "到期/超期伏笔提醒" },
  { key: "includeAntiEchoGuard", tier: "L3", label: "近章防复读去重护栏" },
  { key: "includeTechniques", tier: "L3", label: "写作技法卡注入" },
  { key: "includeDeconstructions", tier: "L3", label: "拆书范本注入" },
  { key: "includeCurrentFocus", tier: "L3", label: "当前焦点与卷弧目标" },
  { key: "includeRelatedHistory", tier: "L3", label: "远期相关章 4D 召回" },
  { key: "includeRollingSummaries", tier: "L3", label: "近期滚动摘要" },
  { key: "includePrevTail", tier: "L3", label: "上一章末尾衔接正文" },
];

export interface ContextPreviewResult {
  readonly report: ContextAssemblyReportDto;
  readonly recommendations: readonly TechniqueRecommendationDto[];
  readonly contextTuning?: ContextTuningConfigDto;
  readonly defaultContextTuning?: ContextTuningConfigDto;
  readonly customizedCount?: number;
}

export function createContextPreviewPanel(container: HTMLElement, host: WorkbenchShellHost) {
  let loading = false;
  let tuningDrawerOpen = false;
  let lastSyncedProjectId = "";

  function syncTokenLimitInput(limit: number): void {
    const form = document.getElementById("start-run") as HTMLFormElement | null;
    const tokenInput = form?.elements.namedItem("tokenLimit") as HTMLInputElement | null;
    if (tokenInput) {
      tokenInput.value = String(limit);
    }
  }

  async function refresh(options: { readonly useProjectDefaultTokenLimit?: boolean } = {}): Promise<void> {
    if (loading) return;
    const { projectId, documentId, snapshot } = host.getState();
    const active = snapshot.active;
    if (!active || active.product !== "fanqie") {
      container.replaceChildren();
      return;
    }
    const form = document.getElementById("start-run") as HTMLFormElement | null;
    const instruction = (form?.elements.namedItem("instruction") as HTMLTextAreaElement | null)?.value ?? "";
    const tokenInputVal = Number((form?.elements.namedItem("tokenLimit") as HTMLInputElement | null)?.value || 0);
    const point = Number((form?.elements.namedItem("point") as HTMLInputElement | null)?.value || 1);

    const switchedProject = projectId !== lastSyncedProjectId;
    const payload: Record<string, unknown> = { documentId, instruction, point };
    if (!options.useProjectDefaultTokenLimit && !switchedProject && Number.isFinite(tokenInputVal) && tokenInputVal >= 1000) {
      payload.tokenLimit = Math.floor(tokenInputVal);
    }

    loading = true;
    try {
      const data = await host.request<ContextPreviewResult>("context.preview", payload);
      if ((switchedProject || options.useProjectDefaultTokenLimit) && data.contextTuning) {
        syncTokenLimitInput(data.contextTuning.defaultTokenLimit);
      }
      lastSyncedProjectId = projectId;
      paint(data);
    } catch (err) {
      container.replaceChildren(
        el("p", err instanceof Error ? err.message : String(err), "status-warning"),
      );
    } finally {
      loading = false;
    }
  }

  function buildTuningDrawer(
    projectId: string,
    activeTuning: ContextTuningConfigDto,
    defaults: ContextTuningConfigDto,
    customizedCount: number,
  ): HTMLElement {
    const draft: Record<string, number | boolean> = { ...activeTuning };

    const details = document.createElement("details");
    details.className = "context-tuning-drawer";
    details.open = tuningDrawerOpen;
    details.addEventListener("toggle", () => {
      tuningDrawerOpen = details.open;
    });

    const summary = document.createElement("summary");
    summary.className = "context-tuning-summary";
    summary.append(
      el("span", "上下文与读取参数调试", "context-tuning-title"),
      el(
        "span",
        customizedCount > 0 ? `已自定义 ${customizedCount} 项` : "默认配置",
        "context-tuning-state tabular",
      ),
    );
    details.append(summary);

    const body = el("div", "", "context-tuning-body");
    body.append(
      el(
        "p",
        "支持按本书自由调节上下文长度、历史读取范围与注入槽位；章纲、当前正文、写作指令与 L0 系统内核始终受保护常驻。",
        "muted-copy",
      ),
    );

    function appendNumericGroup(title: string, specs: readonly NumericFieldSpec[]): void {
      const group = el("div", "", "context-tuning-group");
      group.append(el("h4", title, "context-tuning-group-title"));
      const grid = el("div", "", "context-tuning-grid");
      for (const spec of specs) {
        const currentVal = activeTuning[spec.key];
        const defaultVal = defaults[spec.key];
        const field = createInput({
          kind: "number",
          label: spec.label,
          name: `ctx_${spec.key}`,
          value: String(currentVal),
          min: String(spec.min),
          max: String(spec.max),
          step: String(spec.step),
          hint: currentVal !== defaultVal ? `默认 ${defaultVal}` : spec.hint,
          onInput: (raw) => {
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
              draft[spec.key] = parsed;
            }
          },
        });
        if (currentVal !== defaultVal) {
          field.root.classList.add("context-tuning-modified");
        }
        grid.append(field.root);
      }
      group.append(grid);
      body.append(group);
    }

    appendNumericGroup("上下文长度与分层配额", LENGTH_FIELDS);
    appendNumericGroup("前文与历史读取范围", READING_FIELDS);

    const toggleGroup = el("div", "", "context-tuning-group");
    toggleGroup.append(el("h4", "上下文槽位组合开关", "context-tuning-group-title"));
    const toggleList = el("div", "", "context-tuning-toggles");
    for (const spec of SLOT_TOGGLES) {
      const row = document.createElement("label");
      row.className = "context-tuning-toggle";
      if (activeTuning[spec.key] !== defaults[spec.key]) {
        row.classList.add("context-tuning-modified");
      }
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = `ctx_${spec.key}`;
      box.checked = Boolean(activeTuning[spec.key]);
      box.addEventListener("change", () => {
        draft[spec.key] = box.checked;
      });
      const textWrap = el("span", "", "context-tuning-toggle-text");
      textWrap.append(el("span", `[${spec.tier}] ${spec.label}`, "context-tuning-toggle-label"));
      if (spec.note) {
        textWrap.append(el("span", spec.note, "context-tuning-toggle-note"));
      }
      row.append(box, textWrap);
      toggleList.append(row);
    }
    toggleGroup.append(toggleList);
    body.append(toggleGroup);

    appendNumericGroup("技法与范本截断上限", LIBRARY_CAP_FIELDS);

    const footer = el("div", "", "context-tuning-actions");
    footer.append(
      createButton({
        label: "应用并刷新预览",
        variant: "primary",
        size: "sm",
        onClick: () =>
          void host.perform(async () => {
            const saved = await host.request<{ contextTuning?: ContextTuningConfigDto }>("controls.save", {
              projectId,
              contextTuning: draft as Partial<ContextTuningConfigDto>,
            });
            const nextLimit = saved.contextTuning?.defaultTokenLimit ?? Number(draft.defaultTokenLimit);
            if (Number.isFinite(nextLimit) && nextLimit >= 1000) {
              syncTokenLimitInput(nextLimit);
            }
            host.notice("已保存上下文与读取参数并刷新装配预览");
            await refresh({ useProjectDefaultTokenLimit: true });
          }),
      }),
      createButton({
        label: "恢复默认设置",
        variant: "secondary",
        size: "sm",
        disabled: customizedCount === 0,
        onClick: () =>
          void host.perform(async () => {
            await host.request("controls.reset_context", { projectId });
            syncTokenLimitInput(defaults.defaultTokenLimit);
            host.notice("已恢复全部上下文与读取参数为默认设置");
            await refresh({ useProjectDefaultTokenLimit: true });
          }),
      }),
    );
    body.append(footer);
    details.append(body);
    return details;
  }

  function paint(data: ContextPreviewResult): void {
    const { report, recommendations } = data;
    const { projectId } = host.getState();
    const activeTuning = data.contextTuning ?? FALLBACK_DEFAULT_TUNING;
    const defaultTuning = data.defaultContextTuning ?? FALLBACK_DEFAULT_TUNING;
    const customizedCount = data.customizedCount ?? report.contextCustomizedCount ?? 0;
    container.replaceChildren();

    const header = el("div", "", "context-header");
    header.append(el("h3", "四层上下文装配与缓存预览", "sub-heading"));
    const actions = el("div", "", "context-actions");
    const rebuildBtn = createButton({
      label: "重建圣经快照",
      variant: "secondary",
      size: "sm",
      className: "notice-dismiss",
      onClick: () =>
        void host.perform(async () => {
          await host.request("cache.rebuild", { projectId });
          await refresh();
        }),
    });
    const refreshBtn = createButton({
      label: "刷新装配预览",
      variant: "ghost",
      size: "sm",
      className: "notice-dismiss",
      onClick: () => void refresh(),
    });
    actions.append(rebuildBtn, refreshBtn);
    header.append(actions);
    container.append(header);

    const ratioPct = Math.min(100, Math.round((report.totalEstimatedTokens / Math.max(1, report.maxInputTokens)) * 100));
    const l1Tokens = report.l1Tokens ?? report.prefixTokens;
    const l2Tokens = report.l2Tokens ?? 0;
    const l3Tokens = report.l3Tokens ?? report.dynamicTokens;
    const cacheablePct = report.estimatedCacheableRatio !== undefined
      ? `${(report.estimatedCacheableRatio * 100).toFixed(1)}%`
      : "—";

    container.append(
      el(
        "p",
        `输入总估算 ${report.totalEstimatedTokens.toLocaleString("zh-Hans")} / 配额 ${report.maxInputTokens.toLocaleString("zh-Hans")} token（${ratioPct}%）· L1 ${l1Tokens} · L2 ${l2Tokens} · L3 ${l3Tokens}`,
        "muted-copy tabular",
      ),
    );

    if (report.l1Version !== undefined || report.prefixSha256) {
      const versionLabel = report.l1Version !== undefined ? `L1 圣经快照 v${report.l1Version}` : "L1 圣经快照";
      const hashLabel = report.prefixSha256 ? `前缀哈希 ${report.prefixSha256.slice(0, 10)}` : "";
      const dirtyThreshold = report.l1DirtyThreshold ?? activeTuning.l1DirtyThreshold;
      const dirtyLabel = report.l1DirtyCount !== undefined ? `待合入变更 ${report.l1DirtyCount}/${dirtyThreshold}` : "";
      const cacheSummary = [versionLabel, hashLabel, dirtyLabel, `理论可缓存占比 ${cacheablePct}`]
        .filter(Boolean)
        .join(" · ");
      container.append(el("p", cacheSummary, "muted-copy tabular"));
    }

    const qualitySignals: string[] = [];
    if (typeof report.dueForeshadowCount === "number") {
      qualitySignals.push(`到期伏笔 ${report.dueForeshadowCount} 条`);
    }
    if (typeof report.antiEchoPhraseCount === "number") {
      qualitySignals.push(`防复读高频词 ${report.antiEchoPhraseCount} 项`);
    }
    if (report.autoMatchedTechniqueIds && report.autoMatchedTechniqueIds.length > 0) {
      qualitySignals.push(`自动匹配技法 ${report.autoMatchedTechniqueIds.length} 张`);
    }
    if (report.conflictSkippedTechniqueIds && report.conflictSkippedTechniqueIds.length > 0) {
      qualitySignals.push(`互斥去重略过 ${report.conflictSkippedTechniqueIds.length} 张`);
    }
    if (qualitySignals.length > 0) {
      container.append(el("p", qualitySignals.join(" · "), "setting-meta tabular"));
    }

    const bar = el("div", "", "context-bar");
    const prefixShare = Math.min(100, Math.round((report.prefixTokens / Math.max(1, report.maxInputTokens)) * 100));
    const dynShare = Math.min(100 - prefixShare, Math.round((report.dynamicTokens / Math.max(1, report.maxInputTokens)) * 100));
    const prefixSeg = el("div", "", "context-bar-prefix");
    prefixSeg.style.width = `${prefixShare}%`;
    const dynSeg = el("div", "", "context-bar-dynamic");
    dynSeg.style.width = `${dynShare}%`;
    bar.append(prefixSeg, dynSeg);
    container.append(bar);

    const list = el("ul", "", "context-slot-list");
    for (const slot of report.slots) {
      const row = el("li", "", `context-slot-item slot-status-${slot.status}`);
      const tierTag = slot.tier
        ? (TIER_TAGS[slot.tier] ?? "")
        : slot.group === "prefix"
          ? "[Prefix] "
          : "";
      const cleanLabel = slot.tier
        ? slot.label.replace(/^L[123]\s+/, "")
        : slot.label;
      const left = el("span", `${tierTag}${cleanLabel}`, "slot-name");
      const right = el(
        "span",
        slot.status === "disabled"
          ? "已关闭"
          : `${STATUS_LABELS[slot.status] ?? slot.status} · ${slot.includedTokens}/${slot.rawTokens}`,
        "slot-tokens tabular",
      );
      row.append(left, right);
      list.append(row);
    }
    container.append(list);

    // Author-tunable context & reading configuration drawer with one-click reset to defaults
    container.append(buildTuningDrawer(projectId, activeTuning, defaultTuning, customizedCount));

    if (recommendations.length > 0) {
      container.append(el("h4", "本章技法推荐与挂载状态", "inspector-heading"));
      const recList = el("div", "", "rec-list");
      const { documentId } = host.getState();
      for (const rec of recommendations.slice(0, 5)) {
        const card = el("div", "", "rec-item");
        const title = el("p", `${rec.card.title}（${rec.score}分）`, "setting-title");
        const reason = el(
          "p",
          rec.reasons.join(" · ") || `分类 ${rec.card.category}`,
          "setting-meta",
        );
        const toggleBtn = createButton({
          label: rec.mountedMode && rec.mountTarget === "chapter" ? "取消本章挂载" : "挂载到本章",
          variant: "secondary",
          size: "sm",
          className: "notice-dismiss",
          onClick: () =>
            void host.perform(async () => {
              if (rec.mountedMode && rec.mountTarget === "chapter") {
                await host.request("library.unmount", {
                  projectId,
                  targetType: "chapter",
                  targetId: documentId,
                  itemKind: "technique",
                  itemId: rec.card.id,
                });
              } else {
                await host.request("library.mount", {
                  projectId,
                  targetType: "chapter",
                  targetId: documentId,
                  itemKind: "technique",
                  itemId: rec.card.id,
                  mode: "pin",
                });
              }
              await refresh();
            }),
        });
        card.append(title, reason, toggleBtn);
        recList.append(card);
      }
      container.append(recList);
    }
  }

  return { refresh, clear: () => container.replaceChildren() };
}
