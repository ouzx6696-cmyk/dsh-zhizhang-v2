import type {
  ContextAssemblyReportDto,
  RunBillingSummaryDto,
  RunDetailDto,
  SettingFactDto,
} from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";

interface ParsedFrozenInput {
  readonly title?: string;
  readonly revisionId?: string;
  readonly instruction?: string;
  readonly knownAt?: { readonly chapterId: string; readonly point: number };
  readonly knownFacts?: readonly SettingFactDto[];
  readonly contextBundle?: { readonly report?: ContextAssemblyReportDto };
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  write: "撰写候选",
  qa: "自动质检",
  refine: "定向回改",
};

const ATTEMPT_LABELS: Readonly<Record<string, string>> = {
  prepared: "已准备",
  inflight: "调用中",
  received: "已回执",
  completed: "已完成",
  failed: "已失败",
  uncertain: "用量待核对",
  reconciled: "已对账",
};

function parseUsageTuple(raw: string | null): readonly number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : null;
  } catch {
    return null;
  }
}

function deriveBilling(detail: RunDetailDto): RunBillingSummaryDto {
  if (detail.billing) return detail.billing;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let effectiveBilledTokens = 0;
  let validCalls = 0;
  for (const call of detail.calls) {
    const tuple = parseUsageTuple(call.usage);
    if (!tuple || tuple.length < 2) continue;
    const input = Math.max(0, tuple[0] ?? 0);
    const output = Math.max(0, tuple[1] ?? 0);
    const cacheRead = Math.max(0, tuple[2] ?? 0);
    const cacheWrite = Math.max(0, tuple[3] ?? 0);
    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    effectiveBilledTokens += (cacheRead <= input ? input - cacheRead : input) + output;
    validCalls += 1;
  }
  if (validCalls === 0) {
    return {
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      effectiveBilledTokens: null,
      cacheHitRate: null,
    };
  }
  const cacheHitRate = totalInput > 0
    ? (totalCacheRead <= totalInput ? totalCacheRead / totalInput : totalCacheRead / (totalInput + totalCacheRead))
    : null;
  return { totalInput, totalOutput, totalCacheRead, totalCacheWrite, effectiveBilledTokens, cacheHitRate };
}

/**
 * Renders structured run inspection (frozen context, billing transparency,
 * cache hit rate, recovery hints, attempts, and 4-category tabular token usage).
 */
export function renderRunInspector(target: HTMLElement, detail: RunDetailDto): void {
  target.hidden = false;
  target.replaceChildren();

  let frozen: ParsedFrozenInput = {};
  try {
    frozen = JSON.parse(detail.frozenInput) as ParsedFrozenInput;
  } catch {
    frozen = {};
  }

  const billing = deriveBilling(detail);
  const billedLabel = billing.effectiveBilledTokens !== null
    ? `${billing.effectiveBilledTokens} token`
    : "未知";
  const cacheHitLabel = billing.cacheHitRate !== null
    ? `${(billing.cacheHitRate * 100).toFixed(1)}%`
    : "未知";
  const savingsLabel = billing.estimatedSavingsRatio !== undefined && billing.estimatedSavingsRatio !== null
    ? `${(billing.estimatedSavingsRatio * 100).toFixed(1)}%`
    : "—";

  const header = el("div", { className: "inspector-section" });
  header.append(el("h3", { className: "inspector-heading", text: "冻结上下文" }));
  const meta = el("dl", { className: "inspector-meta" });
  const rows: readonly [string, string][] = [
    ["基准修订", detail.baseRevisionId.slice(0, 8)],
    ["预算账目", `已结算 ${detail.settled} / 总额 ${detail.reserved} token`],
    ["有效计费", billedLabel],
    ["缓存命中率", `${cacheHitLabel}（估算节省 ${savingsLabel}）`],
    ...(billing.cacheDiagnosis ? ([["缓存归因", billing.cacheDiagnosis]] as readonly [string, string][]) : []),
    ["写作要求", frozen.instruction ?? "（无）"],
    [
      "知情设定",
      frozen.knownFacts && frozen.knownFacts.length > 0
        ? `${frozen.knownFacts.length} 条（${frozen.knownFacts.map((f) => f.id).join("、")}）`
        : "0 条",
    ],
  ];
  for (const [label, value] of rows) {
    meta.append(el("dt", { text: label }), el("dd", { className: "tabular", text: value }));
  }
  header.append(meta);
  target.append(header);

  if (detail.recoveryHints && detail.recoveryHints.length > 0) {
    const hintsSec = el("div", { className: "inspector-section" });
    hintsSec.append(el("h3", { className: "inspector-heading status-warning", text: "恢复建议" }));
    const list = el("ul", { className: "inspector-list" });
    for (const hint of detail.recoveryHints) {
      list.append(el("li", { text: hint.message }));
    }
    hintsSec.append(list);
    target.append(hintsSec);
  }

  const ctxReport = detail.contextTrace ?? frozen.contextBundle?.report;
  if (ctxReport) {
    const ctxSec = el("div", { className: "inspector-section" });
    const quotaText = `分层上下文配额（Prefix ${ctxReport.prefixTokens} + 动态 ${ctxReport.dynamicTokens} / 上限 ${ctxReport.maxInputTokens}）`;
    const heading = el("h3", {
      className: ctxReport.overBudget ? "inspector-heading status-warning" : "inspector-heading",
      text: ctxReport.overBudget ? `${quotaText} · 超出输入上限` : quotaText,
    });
    ctxSec.append(heading);
    const list = el("ul", { className: "inspector-list" });
    for (const slot of ctxReport.slots) {
      if (slot.status === "empty") continue;
      list.append(el("li", { text: `${slot.label}：${slot.status}（${slot.includedTokens}/${slot.rawTokens} token）` }));
    }
    ctxSec.append(list);
    target.append(ctxSec);
  }

  if (detail.attempts.length > 0) {
    const attemptsSec = el("div", { className: "inspector-section" });
    attemptsSec.append(el("h3", { className: "inspector-heading", text: `生成尝试（${detail.attempts.length}）` }));
    const list = el("ul", { className: "inspector-list" });
    for (const attempt of detail.attempts) {
      const summary = [
        `${attempt.provider} / ${attempt.model}`,
        ATTEMPT_LABELS[attempt.state] ?? attempt.state,
        attempt.stage ? PHASE_LABELS[attempt.stage] ?? attempt.stage : "",
        attempt.error ? `原因 ${attempt.error}` : "",
      ].filter(Boolean).join(" · ");
      list.append(el("li", { text: summary }));
    }
    attemptsSec.append(list);
    target.append(attemptsSec);
  }

  if (detail.calls.length > 0) {
    const callsSec = el("div", { className: "inspector-section" });
    callsSec.append(el("h3", { className: "inspector-heading", text: "模型调用令牌明细" }));
    const wrap = el("div", { className: "table-scroll" });
    const table = el("table", { className: "token-table" });
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of ["阶段", "预留", "输入", "输出", "缓存读", "缓存写", "策略", "前缀哈希"]) {
      headRow.append(el("th", { text: col }));
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const call of detail.calls) {
      const tuple = parseUsageTuple(call.usage);
      const tr = document.createElement("tr");
      tr.append(
        el("td", { text: PHASE_LABELS[call.phase] ?? call.phase }),
        el("td", { className: "num", text: String(call.inputReserve) }),
        el("td", { className: "num", text: tuple ? String(tuple[0] ?? 0) : "—" }),
        el("td", { className: "num", text: tuple ? String(tuple[1] ?? 0) : "—" }),
        el("td", { className: "num", text: tuple ? String(tuple[2] ?? 0) : "—" }),
        el("td", { className: "num", text: tuple ? String(tuple[3] ?? 0) : "—" }),
        el("td", { text: call.cacheStrategy ?? "—" }),
        el("td", { className: "tabular", text: call.prefixSha256 ? call.prefixSha256.slice(0, 10) : "—" }),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    callsSec.append(wrap);
    target.append(callsSec);
  }

  if (detail.microUsage && detail.microUsage.calls > 0) {
    const micro = detail.microUsage;
    const microSec = el("div", { className: "inspector-section" });
    microSec.append(el("h3", { className: "inspector-heading", text: `微改写累计（本文档 ${micro.calls} 次）` }));
    const microMeta = el("dl", { className: "inspector-meta" });
    const microRows: readonly [string, string][] = [
      ["调用状态", `完成 ${micro.completed} · 失败 ${micro.failed} · 待核对 ${micro.uncertain}`],
      ["输入 / 输出", `${micro.totalInput} / ${micro.totalOutput} token`],
      ["缓存读 / 缓存写", `${micro.totalCacheRead} / ${micro.totalCacheWrite} token`],
      ["已结算", `${micro.settled} token`],
    ];
    for (const [label, value] of microRows) {
      microMeta.append(el("dt", { text: label }), el("dd", { className: "tabular", text: value }));
    }
    microSec.append(microMeta);
    target.append(microSec);
  }

  if (detail.candidate?.body) {
    const candSec = el("div", { className: "inspector-section" });
    candSec.append(el("h3", { className: "inspector-heading", text: "已存档候选正文预览" }));
    const preview = el("p", {
      className: "inspector-preview",
      text: detail.candidate.body.slice(0, 320) + (detail.candidate.body.length > 320 ? "…" : ""),
    });
    candSec.append(preview);
    target.append(candSec);
  }
}
