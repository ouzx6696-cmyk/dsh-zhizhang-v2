import type {
  ContextAssemblyReportDto,
  TechniqueRecommendationDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  included: "完整注入",
  truncated: "配额裁剪",
  dropped: "预算略过",
  empty: "无内容",
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
    container.replaceChildren();

    const header = el("div", "", "context-header");
    header.append(el("h3", "上下文槽位装配器", "sub-heading"));
    const refreshBtn = el("button", "刷新装配预览", "notice-dismiss");
    refreshBtn.type = "button";
    refreshBtn.onclick = () => void refresh();
    header.append(refreshBtn);
    container.append(header);

    const ratioPct = Math.min(100, Math.round((report.totalEstimatedTokens / Math.max(1, report.maxInputTokens)) * 100));
    container.append(
      el(
        "p",
        `输入总估算 ${report.totalEstimatedTokens.toLocaleString("zh-Hans")} / 配额 ${report.maxInputTokens.toLocaleString("zh-Hans")} token（${ratioPct}%）· Prefix 稳定区 ${report.prefixTokens} · 动态尾 ${report.dynamicTokens}`,
        "muted-copy tabular",
      ),
    );

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
      const left = el("span", `${slot.group === "prefix" ? "[Prefix] " : ""}${slot.label}`, "slot-name");
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
      const { projectId, documentId } = host.getState();
      for (const rec of recommendations.slice(0, 5)) {
        const card = el("div", "", "rec-item");
        const title = el("p", `${rec.card.title}（${rec.score}分）`, "setting-title");
        const reason = el(
          "p",
          rec.reasons.join(" · ") || `分类 ${rec.card.category}`,
          "setting-meta",
        );
        const toggleBtn = el(
          "button",
          rec.mountedMode && rec.mountTarget === "chapter" ? "取消本章挂载" : "挂载到本章",
          "notice-dismiss",
        );
        toggleBtn.type = "button";
        toggleBtn.onclick = () =>
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
          });
        card.append(title, reason, toggleBtn);
        recList.append(card);
      }
      container.append(recList);
    }
  }

  return { refresh, clear: () => container.replaceChildren() };
}
