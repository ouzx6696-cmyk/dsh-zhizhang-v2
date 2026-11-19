import { computeParagraphDiff, type ParagraphDiffRow } from "../diff.ts";
import type { CandidateQaReport } from "../types.ts";

export type DiffDisplayMode = "split" | "inline" | "raw";

export interface DiffViewState {
  readonly originalBody: string;
  readonly candidateBody: string;
  readonly candidateQa?: CandidateQaReport;
  readonly refinementRounds: number;
  readonly canAdopt: boolean;
}

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

function isBlankSpacer(row: ParagraphDiffRow): boolean {
  return row.leftText.trim() === "" && row.rightText.trim() === "";
}

function renderSplitTable(rows: readonly ParagraphDiffRow[]): HTMLElement {
  const container = el("div", "diff-split");
  const head = el("div", "diff-split-head");
  head.append(el("span", "diff-col-label", "当前工作稿"), el("span", "diff-col-label", "候选稿"));
  container.append(head);

  for (const row of rows) {
    if (isBlankSpacer(row)) continue;
    const line = el("div", `diff-split-row diff-row-${row.kind}`);

    const leftCell = el("div", "diff-cell diff-cell-left");
    const leftNum = el("span", "diff-line-no", row.leftIndex !== null ? String(row.leftIndex) : "—");
    const leftMark = el(
      "span",
      "diff-marker",
      row.kind === "removed" ? "−" : row.kind === "changed" ? "~" : "",
    );
    const leftText = el("div", "diff-text", row.leftText || (row.kind === "added" ? "" : " "));
    leftCell.append(leftNum, leftMark, leftText);

    const rightCell = el("div", "diff-cell diff-cell-right");
    const rightNum = el("span", "diff-line-no", row.rightIndex !== null ? String(row.rightIndex) : "—");
    const rightMark = el(
      "span",
      "diff-marker",
      row.kind === "added" ? "+" : row.kind === "changed" ? "~" : "",
    );
    const rightText = el("div", "diff-text", row.rightText || (row.kind === "removed" ? "" : " "));
    rightCell.append(rightNum, rightMark, rightText);

    line.append(leftCell, rightCell);
    container.append(line);
  }
  return container;
}

function renderInlineList(rows: readonly ParagraphDiffRow[]): HTMLElement {
  const list = el("div", "diff-inline");
  for (const row of rows) {
    if (isBlankSpacer(row)) continue;
    if (row.kind === "equal") {
      const item = el("div", "diff-inline-row diff-row-equal");
      item.append(
        el("span", "diff-line-no", String(row.rightIndex ?? "")),
        el("span", "diff-marker", " "),
        el("div", "diff-text", row.rightText || " "),
      );
      list.append(item);
      continue;
    }
    if (row.kind === "removed" || row.kind === "changed") {
      const delItem = el("div", "diff-inline-row diff-row-removed");
      delItem.append(
        el("span", "diff-line-no", String(row.leftIndex ?? "")),
        el("span", "diff-marker", "−"),
        el("div", "diff-text", row.leftText || " "),
      );
      list.append(delItem);
    }
    if (row.kind === "added" || row.kind === "changed") {
      const addItem = el("div", "diff-inline-row diff-row-added");
      addItem.append(
        el("span", "diff-line-no", String(row.rightIndex ?? "")),
        el("span", "diff-marker", "+"),
        el("div", "diff-text", row.rightText || " "),
      );
      list.append(addItem);
    }
  }
  return list;
}

export function createDiffView(container: HTMLElement) {
  let mode: DiffDisplayMode = "split";
  let lastState: DiffViewState | null = null;

  const summaryEl = container.querySelector<HTMLElement>("#diff-summary")!;
  const bodyEl = container.querySelector<HTMLElement>("#diff-surface")!;
  const rawEl = container.querySelector<HTMLTextAreaElement>("#candidate")!;
  const qaEl = container.querySelector<HTMLElement>("#candidate-qa")!;
  const adoptBtn = container.querySelector<HTMLButtonElement>("#adopt")!;
  const modeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-diff-mode]"));

  function paint(): void {
    if (!lastState) return;
    const { originalBody, candidateBody, candidateQa, refinementRounds, canAdopt } = lastState;
    const diff = computeParagraphDiff(originalBody, candidateBody);
    const visibleRows = diff.rows.filter((row) => !isBlankSpacer(row));
    const changedCount = visibleRows.filter((row) => row.kind === "changed").length;
    const addedCount = visibleRows.filter((row) => row.kind === "added").length;
    const removedCount = visibleRows.filter((row) => row.kind === "removed").length;
    const unchangedCount = visibleRows.filter((row) => row.kind === "equal").length;

    summaryEl.textContent = [
      `修改 ${changedCount} 段`,
      `新增 ${addedCount} 段`,
      `删除 ${removedCount} 段`,
      `未变 ${unchangedCount} 段`,
    ].join(" · ");

    rawEl.value = candidateBody;
    rawEl.hidden = mode !== "raw";
    bodyEl.hidden = mode === "raw";

    if (mode === "split") {
      bodyEl.replaceChildren(renderSplitTable(diff.rows));
    } else if (mode === "inline") {
      bodyEl.replaceChildren(renderInlineList(diff.rows));
    }

    if (candidateQa) {
      qaEl.hidden = false;
      qaEl.textContent = [
        `候选稿质检 ${candidateQa.overall} 分`,
        `回改 ${refinementRounds} 轮`,
        ...candidateQa.hardGates,
        ...candidateQa.fails,
      ].join(" · ");
    } else {
      qaEl.hidden = true;
      qaEl.textContent = "";
    }

    adoptBtn.disabled = !canAdopt;
    for (const button of modeButtons) {
      const active = button.dataset.diffMode === mode;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("active", active);
    }
  }

  for (const button of modeButtons) {
    button.onclick = () => {
      const next = button.dataset.diffMode as DiffDisplayMode | undefined;
      if (!next || next === mode) return;
      mode = next;
      paint();
    };
  }

  return {
    update(state: DiffViewState | null): void {
      lastState = state;
      container.hidden = state === null;
      if (state) paint();
    },
  };
}
