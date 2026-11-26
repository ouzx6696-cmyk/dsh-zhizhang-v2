import type { CandidateQaReport } from "../../../contracts/workspace-dto.ts";
import {
  computeInlineDiff,
  computeParagraphDiff,
  countNonWhitespaceChars,
  mergeParagraphSelections,
  type ParagraphDiffRow,
  type ParagraphDiffSummary,
} from "../diff.ts";
import { el } from "../dom.ts";
import { createButton } from "../ui/primitives.ts";

export type DiffDisplayMode = "split" | "inline" | "raw";

export interface DiffViewState {
  readonly candidateId?: string | null;
  readonly baseCandidateId?: string | null;
  readonly originalBody: string;
  readonly candidateBody: string;
  readonly candidateQa?: CandidateQaReport;
  readonly refinementRounds: number;
  readonly canAdopt: boolean;
}

export interface DiffViewCallbacks {
  readonly onLocate?: (paragraphText: string, leftIndex: number | null) => void;
  readonly computeParagraphDiffAsync?: (original: string, candidate: string) => Promise<ParagraphDiffSummary>;
}

export interface DiffAdoptionPlan {
  readonly mergedBody: string;
  readonly adoptionMode: "full" | "partial";
  readonly selectedCount: number;
  readonly totalHunks: number;
}

const MAX_UNDO_STEPS = 30;
const BLANK_SPACER_LABEL = "（空行分隔）";

function isBlankSpacer(row: ParagraphDiffRow): boolean {
  return row.leftText.trim() === "" && row.rightText.trim() === "";
}

function renderInlineSpans(target: HTMLElement, left: string, right: string, side: "left" | "right"): void {
  const segs = computeInlineDiff(left, right);
  for (const seg of segs) {
    if (seg.kind === "equal") {
      target.append(document.createTextNode(seg.text));
    } else if (seg.kind === "removed" && side === "left") {
      target.append(el("del", { className: "diff-char-del", text: seg.text }));
    } else if (seg.kind === "added" && side === "right") {
      target.append(el("ins", { className: "diff-char-ins", text: seg.text }));
    }
  }
}

function buildHunkControls(
  rowIndex: number,
  row: ParagraphDiffRow,
  adopted: boolean,
  onToggle: (idx: number, next: boolean) => void,
  onLocate?: (text: string, leftIndex: number | null) => void,
): HTMLElement {
  const wrap = el("span", { className: "diff-hunk-controls" });
  const label = el("label", { className: "diff-check-label" });
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.hunkIndex = String(rowIndex);
  cb.checked = adopted;
  cb.onchange = () => onToggle(rowIndex, cb.checked);
  label.append(cb, document.createTextNode(" 采纳"));
  wrap.append(label);

  if (onLocate) {
    const locBtn = createButton({
      label: "定位",
      variant: "ghost",
      size: "sm",
      className: "diff-locate-btn",
      onClick: () => onLocate(row.leftText || row.rightText, row.leftIndex),
    });
    wrap.append(locBtn);
  }
  return wrap;
}

export function createDiffView(container: HTMLElement, callbacks?: DiffViewCallbacks) {
  let mode: DiffDisplayMode = "split";
  let lastState: DiffViewState | null = null;
  let lastCandidateId: string | null = null;
  let lastOriginalBody: string | null = null;
  let lastCandidateBody: string | null = null;
  let diffSummary: ParagraphDiffSummary = computeParagraphDiff("", "");
  let hunkIndices: number[] = [];
  let showBlankOnlyHunks = false;
  let adopted = new Set<number>();
  let computeSeq = 0;
  let activeHunkCursor = -1;
  const undoStack: Set<number>[] = [];

  const summaryEl = container.querySelector<HTMLElement>("#diff-summary")!;
  const bodyEl = container.querySelector<HTMLElement>("#diff-surface")!;
  const rawEl = container.querySelector<HTMLTextAreaElement>("#candidate")!;
  const qaEl = container.querySelector<HTMLElement>("#candidate-qa")!;
  const adoptBtn = container.querySelector<HTMLButtonElement>("#adopt")!;
  const modeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-diff-mode]"));

  function pushUndo(): void {
    undoStack.push(new Set(adopted));
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  }

  function hasPartialSelection(): boolean {
    return hunkIndices.length > 0 && adopted.size < hunkIndices.length;
  }

  function currentMerged(): string {
    if (!lastState) return "";
    if (hunkIndices.length === 0) return lastState.candidateBody;
    if (adopted.size === hunkIndices.length) {
      return lastState.candidateBody;
    }
    return mergeParagraphSelections(diffSummary, adopted);
  }

  function refreshMergePreviewHeader(mergeBar: HTMLElement): void {
    const mergedText = currentMerged();
    const chars = countNonWhitespaceChars(mergedText);
    const status = mergeBar.querySelector<HTMLElement>("[data-merge-status]");
    if (status) {
      status.textContent = `已勾选 ${adopted.size} / ${hunkIndices.length} 处变更 · 合稿预计 ${chars} 字`;
    }
    const undoBtn = mergeBar.querySelector<HTMLButtonElement>("[data-merge-undo]");
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    const pre = mergeBar.querySelector<HTMLElement>("[data-merge-preview]");
    if (pre) pre.textContent = mergedText;
  }

  function buildRawPartialBanner(): HTMLElement {
    const banner = el("div", { className: "diff-raw-banner" });
    banner.dataset.rawPartialBanner = "true";
    banner.setAttribute("role", "status");
    const msg = el("span", {
      className: "diff-raw-banner-text tabular",
      text: `当前勾选 ${adopted.size} / ${hunkIndices.length} 处变更，采纳仍将按勾选合稿（不会整篇覆盖）`,
    });
    const backBtn = createButton({
      label: "返回并排对照",
      variant: "secondary",
      size: "sm",
      className: "diff-raw-back-btn",
      dataset: { diffBackSplit: "true" },
      onClick: () => {
        mode = "split";
        paintDiffSurfaceOnly();
        paintMetadata();
      },
    });
    banner.append(msg, backBtn);
    return banner;
  }

  function buildMergeBar(): HTMLElement {
    const bar = el("div", { className: "diff-merge-bar" });
    const row = el("div", { className: "diff-merge-row" });
    const status = el("span", { className: "muted-copy tabular" });
    status.dataset.mergeStatus = "true";

    const actions = el("div", { className: "actions" });
    const allBtn = createButton({
      label: "全选变更",
      variant: "secondary",
      size: "sm",
      onClick: () => {
        pushUndo();
        adopted = new Set(hunkIndices);
        paintDiffSurfaceOnly();
      },
    });
    const noneBtn = createButton({
      label: "全不选",
      variant: "secondary",
      size: "sm",
      onClick: () => {
        pushUndo();
        adopted = new Set();
        paintDiffSurfaceOnly();
      },
    });
    const undoBtn = createButton({
      label: "撤销选择",
      variant: "secondary",
      size: "sm",
      disabled: undoStack.length === 0,
      dataset: { mergeUndo: "true" },
      onClick: () => {
        const prev = undoStack.pop();
        if (!prev) return;
        adopted = new Set(prev);
        paintDiffSurfaceOnly();
      },
    });
    actions.append(allBtn, noneBtn, undoBtn);
    row.append(status, actions);

    const details = el("details", { className: "disclosure" });
    details.append(el("summary", { text: "预览顶部合稿结果" }));
    const pre = el("pre", { className: "server-body-preview" });
    pre.dataset.mergePreview = "true";
    details.append(pre);

    bar.append(row, details);
    refreshMergePreviewHeader(bar);
    return bar;
  }

  function toggleHunk(idx: number, next: boolean): void {
    pushUndo();
    if (next) adopted.add(idx);
    else adopted.delete(idx);
    const bar = bodyEl.querySelector<HTMLElement>(".diff-merge-bar");
    if (bar) refreshMergePreviewHeader(bar);
  }

  function shouldRenderRow(row: ParagraphDiffRow): boolean {
    if (!isBlankSpacer(row)) return true;
    return showBlankOnlyHunks && row.kind !== "equal";
  }

  function renderSplitTable(): HTMLElement {
    const table = el("div", { className: "diff-split" });
    const head = el("div", { className: "diff-split-head" });
    head.append(
      el("span", { className: "diff-col-label", text: "当前工作稿" }),
      el("span", { className: "diff-col-label", text: "候选稿（点击勾选外科合稿）" }),
    );
    table.append(head);

    diffSummary.rows.forEach((row, idx) => {
      if (!shouldRenderRow(row)) return;
      const blank = isBlankSpacer(row);
      const line = el("div", { className: `diff-split-row diff-row-${row.kind}` });
      if (row.kind !== "equal") line.dataset.hunkRow = String(idx);

      const leftCell = el("div", { className: "diff-cell diff-cell-left" });
      leftCell.append(
        el("span", { className: "diff-line-no", text: row.leftIndex !== null ? String(row.leftIndex) : "—" }),
        el("span", { className: "diff-marker", text: row.kind === "removed" ? "−" : row.kind === "changed" ? "~" : "" }),
      );
      const leftText = el("div", { className: "diff-text" });
      if (blank) {
        leftText.textContent = row.kind === "removed" ? BLANK_SPACER_LABEL : "";
      } else if (row.kind === "changed") {
        renderInlineSpans(leftText, row.leftText, row.rightText, "left");
      } else {
        leftText.textContent = row.leftText || (row.kind === "added" ? "" : " ");
      }
      leftCell.append(leftText);

      const rightCell = el("div", { className: "diff-cell diff-cell-right" });
      rightCell.append(
        el("span", { className: "diff-line-no", text: row.rightIndex !== null ? String(row.rightIndex) : "—" }),
        el("span", { className: "diff-marker", text: row.kind === "added" ? "+" : row.kind === "changed" ? "~" : "" }),
      );
      const rightCol = el("div", { className: "diff-right-wrap" });
      const rightText = el("div", { className: "diff-text" });
      if (blank) {
        rightText.textContent = row.kind === "added" ? BLANK_SPACER_LABEL : "";
      } else if (row.kind === "changed") {
        renderInlineSpans(rightText, row.leftText, row.rightText, "right");
      } else {
        rightText.textContent = row.rightText || (row.kind === "removed" ? "" : " ");
      }
      rightCol.append(rightText);
      if (row.kind !== "equal") {
        rightCol.append(buildHunkControls(idx, row, adopted.has(idx), toggleHunk, callbacks?.onLocate));
      }
      rightCell.append(rightCol);

      line.append(leftCell, rightCell);
      table.append(line);
    });
    return table;
  }

  function renderInlineList(): HTMLElement {
    const list = el("div", { className: "diff-inline" });
    diffSummary.rows.forEach((row, idx) => {
      if (!shouldRenderRow(row)) return;
      const blank = isBlankSpacer(row);
      if (row.kind === "equal") {
        const item = el("div", { className: "diff-inline-row diff-row-equal" });
        item.append(
          el("span", { className: "diff-line-no", text: String(row.rightIndex ?? "") }),
          el("span", { className: "diff-marker", text: " " }),
          el("div", { className: "diff-text", text: row.rightText || " " }),
        );
        list.append(item);
        return;
      }
      if (row.kind === "changed") {
        const chg = el("div", { className: "diff-inline-row diff-row-changed" });
        chg.dataset.hunkRow = String(idx);
        chg.append(
          el("span", { className: "diff-line-no", text: String(row.rightIndex ?? row.leftIndex ?? "") }),
          el("span", { className: "diff-marker", text: "~" }),
        );
        const content = el("div", { className: "diff-right-wrap" });
        const inlineText = el("div", { className: "diff-text" });
        for (const seg of computeInlineDiff(row.leftText, row.rightText)) {
          if (seg.kind === "equal") inlineText.append(document.createTextNode(seg.text));
          else if (seg.kind === "removed") inlineText.append(el("del", { className: "diff-char-del", text: seg.text }));
          else inlineText.append(el("ins", { className: "diff-char-ins", text: seg.text }));
        }
        content.append(inlineText, buildHunkControls(idx, row, adopted.has(idx), toggleHunk, callbacks?.onLocate));
        chg.append(content);
        list.append(chg);
        return;
      }
      const cls = row.kind === "removed" ? "diff-row-removed" : "diff-row-added";
      const item = el("div", { className: `diff-inline-row ${cls}` });
      item.dataset.hunkRow = String(idx);
      item.append(
        el("span", { className: "diff-line-no", text: String(row.kind === "removed" ? row.leftIndex ?? "" : row.rightIndex ?? "") }),
        el("span", { className: "diff-marker", text: row.kind === "removed" ? "−" : "+" }),
      );
      const content = el("div", { className: "diff-right-wrap" });
      content.append(
        el("div", {
          className: "diff-text",
          text: blank ? BLANK_SPACER_LABEL : (row.kind === "removed" ? row.leftText : row.rightText) || " ",
        }),
        buildHunkControls(idx, row, adopted.has(idx), toggleHunk, callbacks?.onLocate),
      );
      item.append(content);
      list.append(item);
    });
    return list;
  }

  function paintDiffSurfaceOnly(): void {
    rawEl.hidden = mode !== "raw";
    if (mode === "raw") {
      if (hasPartialSelection()) {
        bodyEl.hidden = false;
        bodyEl.replaceChildren(buildRawPartialBanner());
      } else {
        bodyEl.hidden = true;
        bodyEl.replaceChildren();
      }
      return;
    }
    bodyEl.hidden = false;
    if (mode === "split") {
      bodyEl.replaceChildren(buildMergeBar(), renderSplitTable());
    } else if (mode === "inline") {
      bodyEl.replaceChildren(buildMergeBar(), renderInlineList());
    }
  }

  function applyComputedDiff(summary: ParagraphDiffSummary): void {
    diffSummary = summary;
    const nonBlankHunks: number[] = [];
    const blankHunks: number[] = [];
    diffSummary.rows.forEach((row, idx) => {
      if (row.kind === "equal") return;
      if (isBlankSpacer(row)) blankHunks.push(idx);
      else nonBlankHunks.push(idx);
    });
    showBlankOnlyHunks = nonBlankHunks.length === 0 && blankHunks.length > 0;
    hunkIndices = showBlankOnlyHunks ? blankHunks : nonBlankHunks;
    adopted = new Set(hunkIndices);
    undoStack.length = 0;
    activeHunkCursor = -1;
    paintDiffSurfaceOnly();
  }

  function paintMetadata(): void {
    if (!lastState) return;
    const { candidateBody, candidateQa, refinementRounds, canAdopt } = lastState;
    const visibleRows = diffSummary.rows.filter((row) => shouldRenderRow(row));
    summaryEl.textContent = [
      ...(lastState.baseCandidateId ? [`沿用候选 ${lastState.baseCandidateId.slice(0, 8)}`] : []),
      `修改 ${visibleRows.filter((r) => r.kind === "changed").length} 段`,
      `新增 ${visibleRows.filter((r) => r.kind === "added").length} 段`,
      `删除 ${visibleRows.filter((r) => r.kind === "removed").length} 段`,
      `未变 ${visibleRows.filter((r) => r.kind === "equal").length} 段`,
    ].join(" · ");
    rawEl.value = candidateBody;
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
      paintDiffSurfaceOnly();
      paintMetadata();
    };
  }

  // Keyboard hunk jump (Alt+ArrowDown / Alt+ArrowUp or J / K when not typing in textarea)
  const onKeyDown = (event: KeyboardEvent) => {
    if (mode === "raw" || hunkIndices.length === 0) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toUpperCase() ?? "";
    if (tag === "TEXTAREA" || (tag === "INPUT" && (target as HTMLInputElement).type !== "checkbox")) return;

    let delta = 0;
    if ((event.altKey && event.key === "ArrowDown") || (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "j")) {
      delta = 1;
    } else if ((event.altKey && event.key === "ArrowUp") || (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "k")) {
      delta = -1;
    }
    if (delta === 0) return;

    event.preventDefault?.();
    activeHunkCursor =
      activeHunkCursor === -1
        ? (delta > 0 ? 0 : hunkIndices.length - 1)
        : (activeHunkCursor + delta + hunkIndices.length) % hunkIndices.length;
    const targetRowIdx = String(hunkIndices[activeHunkCursor]);
    const cb = bodyEl.querySelector<HTMLInputElement>(`input[data-hunk-index="${targetRowIdx}"]`);
    cb?.focus?.();
  };
  container.addEventListener?.("keydown", onKeyDown);

  return {
    update(state: DiffViewState | null): void {
      lastState = state;
      container.hidden = state === null;
      if (!state) {
        lastCandidateId = null;
        lastOriginalBody = null;
        lastCandidateBody = null;
        computeSeq++;
        return;
      }
      const nextCandidateId = state.candidateId ?? "";
      const contentChanged =
        nextCandidateId !== lastCandidateId ||
        state.originalBody !== lastOriginalBody ||
        state.candidateBody !== lastCandidateBody;
      if (contentChanged) {
        lastCandidateId = nextCandidateId;
        lastOriginalBody = state.originalBody;
        lastCandidateBody = state.candidateBody;
        const seq = ++computeSeq;
        if (callbacks?.computeParagraphDiffAsync) {
          summaryEl.textContent = "计算差异中…";
          void callbacks.computeParagraphDiffAsync(state.originalBody, state.candidateBody).then((summary) => {
            if (seq !== computeSeq || !lastState) return;
            applyComputedDiff(summary);
            paintMetadata();
          });
        } else {
          applyComputedDiff(computeParagraphDiff(state.originalBody, state.candidateBody));
        }
      }
      paintMetadata();
    },

    getAdoptionPayload(): DiffAdoptionPlan | null {
      if (!lastState) return null;
      const totalHunks = hunkIndices.length;
      const isFull = totalHunks === 0 || adopted.size === totalHunks;
      return {
        mergedBody: isFull ? lastState.candidateBody : currentMerged(),
        adoptionMode: isFull ? "full" : "partial",
        selectedCount: isFull ? totalHunks : adopted.size,
        totalHunks,
      };
    },
  };
}
