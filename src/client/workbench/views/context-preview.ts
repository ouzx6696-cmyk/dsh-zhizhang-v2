import type {
  ContextAssemblyReportDto,
  TechniqueRecommendationDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton } from "../ui/primitives.ts";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  included: "完整注入",
  truncated: "配额裁剪",
  dropped: "预算略过",
  empty: "无内容",
};

const TIER_TAGS: Readonly<Record<string, string>> = {
  l1: "[L1] ",
  l2: "[L2] ",
  l3: "[L3] ",
};

export interface ContextPreviewResult {
  readonly report: ContextAssemblyReportDto;
  readonly recommendations: readonly TechniqueRecommendationDto[];
}

export function createContextPreviewPanel(container: HTMLElement, host: WorkbenchShellHost) {
  let loading = false;

  async function refresh(): Promise<void> {
    if (loading) return;
    const { documentId, snapshot } = host.getState();
    const active = snapshot.active;
    if (!active || active.product !== "fanqie") {
      container.replaceChildren();
      return;
    }
    const form = document.getElementById("start-run") as HTMLFormElement | null;
    const instruction = (form?.elements.namedItem("instruction") as HTMLTextAreaElement | null)?.value ?? "";
    const tokenLimit = Number((form?.elements.namedItem("tokenLimit") as HTMLInputElement | null)?.value || 16000);
    const point = Number((form?.elements.namedItem("point") as HTMLInputElement | null)?.value || 1);

    loading = true;
    try {
      const data = await host.request<ContextPreviewResult>("context.preview", {
        documentId,
        instruction,
        tokenLimit,
        point,
      });
      paint(data);
    } catch (err) {
      container.replaceChildren(
        el("p", err instanceof Error ? err.message : String(err), "status-warning"),
      );
    } finally {
      loading = false;
    }
  }

  function paint(data: ContextPreviewResult): void {
    const { report, recommendations } = data;
    const { projectId } = host.getState();
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
      const dirtyLabel = report.l1DirtyCount !== undefined ? `待合入变更 ${report.l1DirtyCount}/10` : "";
      const cacheSummary = [versionLabel, hashLabel, dirtyLabel, `理论可缓存占比 ${cacheablePct}`]
        .filter(Boolean)
        .join(" · ");
      container.append(el("p", cacheSummary, "muted-copy tabular"));
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
        `${STATUS_LABELS[slot.status] ?? slot.status} · ${slot.includedTokens}/${slot.rawTokens}`,
        "slot-tokens tabular",
      );
      row.append(left, right);
      list.append(row);
    }
    container.append(list);

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
