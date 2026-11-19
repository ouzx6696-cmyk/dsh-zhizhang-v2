import type { RunDetailDto, SettingFactDto } from "../types.ts";

interface ParsedFrozenInput {
  readonly title?: string;
  readonly revisionId?: string;
  readonly instruction?: string;
  readonly knownAt?: { readonly chapterId: string; readonly point: number };
  readonly knownFacts?: readonly SettingFactDto[];
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function parseUsageTuple(raw: string | null): readonly number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : null;
  } catch {
    return null;
  }
}

/**
 * Renders structured run inspection (frozen context, known facts, attempts,
 * and 4-category tabular token usage) instead of raw JSON `<pre>` dumps.
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

  const header = el("div", "inspector-section");
  header.append(el("h3", "inspector-heading", "冻结上下文"));
  const meta = el("dl", "inspector-meta");
  const rows: readonly [string, string][] = [
    ["基准修订", detail.baseRevisionId.slice(0, 8)],
    ["预算账目", `已结算 ${detail.settled} / 总额 ${detail.reserved} token`],
    ["写作要求", frozen.instruction ?? "（无）"],
    [
      "知情设定",
      frozen.knownFacts && frozen.knownFacts.length > 0
        ? `${frozen.knownFacts.length} 条（${frozen.knownFacts.map((f) => f.id).join("、")}）`
        : "0 条",
    ],
  ];
  for (const [label, value] of rows) {
    meta.append(el("dt", undefined, label), el("dd", "tabular", value));
  }
  header.append(meta);
  target.append(header);

  if (detail.attempts.length > 0) {
    const attemptsSec = el("div", "inspector-section");
    attemptsSec.append(el("h3", "inspector-heading", `生成尝试（${detail.attempts.length}）`));
    const list = el("ul", "inspector-list");
    for (const attempt of detail.attempts) {
      const summary = [
        `${attempt.provider} / ${attempt.model}`,
        ATTEMPT_LABELS[attempt.state] ?? attempt.state,
        attempt.stage ? PHASE_LABELS[attempt.stage] ?? attempt.stage : "",
        attempt.error ? `原因 ${attempt.error}` : "",
      ].filter(Boolean).join(" · ");
      list.append(el("li", undefined, summary));
    }
    attemptsSec.append(list);
    target.append(attemptsSec);
  }

  if (detail.calls.length > 0) {
    const callsSec = el("div", "inspector-section");
    callsSec.append(el("h3", "inspector-heading", "模型调用令牌明细"));
    const wrap = el("div", "table-scroll");
    const table = el("table", "token-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of ["阶段", "预留", "输入", "输出", "缓存读", "缓存写"]) {
      headRow.append(el("th", undefined, col));
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const call of detail.calls) {
      const tuple = parseUsageTuple(call.usage);
      const tr = document.createElement("tr");
      tr.append(
        el("td", undefined, PHASE_LABELS[call.phase] ?? call.phase),
        el("td", "num", String(call.inputReserve)),
        el("td", "num", tuple ? String(tuple[0] ?? 0) : "—"),
        el("td", "num", tuple ? String(tuple[1] ?? 0) : "—"),
        el("td", "num", tuple ? String(tuple[2] ?? 0) : "—"),
        el("td", "num", tuple ? String(tuple[3] ?? 0) : "—"),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    callsSec.append(wrap);
    target.append(callsSec);
  }

  if (detail.candidate?.body) {
    const candSec = el("div", "inspector-section");
    candSec.append(el("h3", "inspector-heading", "已存档候选正文预览"));
    const preview = el("p", "inspector-preview", detail.candidate.body.slice(0, 320) + (detail.candidate.body.length > 320 ? "…" : ""));
    candSec.append(preview);
    target.append(candSec);
  }
}
