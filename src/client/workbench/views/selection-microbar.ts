import type { SelectionRewriteMode, SelectionRewriteResultDto } from "../../../contracts/workspace-dto.ts";
import { computeInlineDiff, countNonWhitespaceChars } from "../diff.ts";
import { el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";

export interface SelectionMicrobarOptions {
  readonly getProviderModel: () => { readonly provider: string; readonly model: string };
}

export interface CapturedSelection {
  readonly documentId: string;
  readonly revisionId: string | null;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type SelectionMatchResult =
  | { readonly ok: true; readonly start: number; readonly end: number; readonly relocated: boolean }
  | { readonly ok: false; readonly reason: "document-changed" | "not-found" | "ambiguous" };

export interface AiUndoEntry {
  readonly documentId: string;
  readonly start: number;
  readonly before: string;
  readonly after: string;
}

const MAX_AI_UNDO_STEPS = 10;

/**
 * Verifies that a captured selection still belongs to the active document and
 * resolves its safe replacement bounds. If edits before the selection shifted
 * its offset, relocates ONLY when `captured.text` appears uniquely in the body;
 * refuses on 0 matches, >1 ambiguous matches, or document change (FE-01).
 */
export function resolveCapturedSelection(
  captured: CapturedSelection,
  currentDocumentId: string,
  currentBody: string,
): SelectionMatchResult {
  if (currentDocumentId !== captured.documentId) {
    return { ok: false, reason: "document-changed" };
  }
  if (
    captured.start >= 0 &&
    captured.end <= currentBody.length &&
    currentBody.slice(captured.start, captured.end) === captured.text
  ) {
    return { ok: true, start: captured.start, end: captured.end, relocated: false };
  }
  if (!captured.text) {
    return { ok: false, reason: "not-found" };
  }
  const firstIdx = currentBody.indexOf(captured.text);
  if (firstIdx === -1) {
    return { ok: false, reason: "not-found" };
  }
  const secondIdx = currentBody.indexOf(captured.text, firstIdx + 1);
  if (secondIdx !== -1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, start: firstIdx, end: firstIdx + captured.text.length, relocated: true };
}

/**
 * Replaces the active `[start, end]` range in the `<textarea>`, preferring
 * `document.execCommand("insertText")` so native `Ctrl+Z` undo stays intact,
 * and falling back to `setRangeText(..., "select")` + `input` event dispatch
 * when `execCommand` is unavailable or returns `false` (FE-02).
 *
 * Returns `true` when the `execCommand` path succeeded.
 */
export function applySelectionReplacement(
  editor: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
): boolean {
  const beforeValue = editor.value;
  const expectedAfter = beforeValue.slice(0, start) + replacement + beforeValue.slice(end);
  let usedExecCommand = false;

  if (
    typeof document !== "undefined" &&
    typeof document.execCommand === "function" &&
    typeof editor.setSelectionRange === "function"
  ) {
    let inputFired = false;
    const onInput = () => {
      inputFired = true;
    };
    editor.addEventListener?.("input", onInput);
    try {
      editor.focus?.();
      editor.setSelectionRange(start, end);
      const ok = document.execCommand("insertText", false, replacement);
      if (ok && editor.value === expectedAfter) {
        usedExecCommand = true;
        editor.setSelectionRange(start, start + replacement.length);
      }
    } catch {
      usedExecCommand = false;
    } finally {
      editor.removeEventListener?.("input", onInput);
    }
    if (usedExecCommand && !inputFired && typeof Event === "function" && typeof editor.dispatchEvent === "function") {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  if (!usedExecCommand) {
    if (typeof editor.setRangeText === "function") {
      editor.focus?.();
      editor.setRangeText(replacement, start, end, "select");
    } else {
      editor.value = expectedAfter;
      if (typeof editor.setSelectionRange === "function") {
        editor.setSelectionRange(start, start + replacement.length);
      } else {
        editor.selectionStart = start;
        editor.selectionEnd = start + replacement.length;
      }
    }
    if (typeof Event === "function" && typeof editor.dispatchEvent === "function") {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return usedExecCommand;
}

function failureNoticeForReason(reason: "document-changed" | "not-found" | "ambiguous"): string {
  if (reason === "document-changed") {
    return "已切换到其他章节，已拒绝应用原选段替换，请重新选择。";
  }
  if (reason === "ambiguous") {
    return "原选段偏移已变化且正文存在多处相同片段，为防错位已拒绝替换，请重新选择。";
  }
  return "原选段已变化，无法安全替换，请重新选择。";
}

export function createSelectionMicrobar(
  editor: HTMLTextAreaElement,
  host: WorkbenchShellHost,
  options: SelectionMicrobarOptions,
) {
  const hostParent = editor.parentElement;
  const bar = el("div", { className: "selection-microbar" });
  bar.hidden = true;

  const modeGroup = el("div", { className: "selection-mode-group" });
  const undoBtn = el("button", { className: "selection-microbar-undo", text: "撤销上次 AI 替换" });
  undoBtn.type = "button";
  undoBtn.dataset.selectionUndo = "true";
  undoBtn.hidden = true;

  const previewCard = el("div", { className: "selection-diff-card" });
  previewCard.hidden = true;

  const modes: ReadonlyArray<readonly [SelectionRewriteMode, string]> = [
    ["polish", "润色"],
    ["expand", "扩写"],
    ["dialogue", "改对话"],
    ["continue", "选段续写"],
    ["custom", "自定义…"],
  ];

  let activeSelection: { start: number; end: number; text: string } | null = null;
  let lastDocumentId = host.getState().documentId;
  let requestSeq = 0;
  const aiUndoStack: AiUndoEntry[] = [];

  function findLatestUndoIndex(docId: string): number {
    for (let i = aiUndoStack.length - 1; i >= 0; i--) {
      if (aiUndoStack[i].documentId === docId) return i;
    }
    return -1;
  }

  function hasUndoForActiveDoc(): boolean {
    if (editor.readOnly) return false;
    return findLatestUndoIndex(host.getState().documentId) !== -1;
  }

  function pushAiUndo(entry: AiUndoEntry): void {
    aiUndoStack.push(entry);
    while (aiUndoStack.length > MAX_AI_UNDO_STEPS) {
      aiUndoStack.shift();
    }
  }

  function hidePreview(): void {
    previewCard.hidden = true;
    previewCard.replaceChildren();
  }

  function hideAll(): void {
    requestSeq++;
    activeSelection = null;
    hidePreview();
    bar.hidden = true;
  }

  function currentSelection(): { start: number; end: number; text: string } | null {
    if (editor.readOnly) return null;
    const start = editor.selectionStart ?? 0;
    const end = editor.selectionEnd ?? 0;
    if (end <= start) return null;
    const selected = editor.value.slice(start, end);
    if (countNonWhitespaceChars(selected) < 4) return null;
    return { start, end, text: selected };
  }

  function syncToolbarVisibility(): void {
    const currentDocId = host.getState().documentId;
    if (currentDocId !== lastDocumentId) {
      lastDocumentId = currentDocId;
      requestSeq++;
      activeSelection = null;
      hidePreview();
    }

    const sel = currentSelection();
    const canUndo = hasUndoForActiveDoc();
    undoBtn.hidden = !canUndo;
    if (!sel) {
      modeGroup.hidden = previewCard.hidden;
      bar.hidden = previewCard.hidden && !canUndo;
      return;
    }
    activeSelection = sel;
    modeGroup.hidden = false;
    bar.hidden = false;
  }

  function undoLastReplacement(): boolean {
    if (editor.readOnly) return false;
    const currentDocId = host.getState().documentId;
    const idx = findLatestUndoIndex(currentDocId);
    if (idx === -1) return false;
    const entry = aiUndoStack[idx];
    const match = resolveCapturedSelection(
      {
        documentId: entry.documentId,
        revisionId: null,
        start: entry.start,
        end: entry.start + entry.after.length,
        text: entry.after,
      },
      currentDocId,
      editor.value,
    );
    if (!match.ok) {
      host.notice("正文在替换后已变动，无法安全自动撤销上次 AI 替换，请手动核对。", true);
      return false;
    }
    aiUndoStack.splice(idx, 1);
    applySelectionReplacement(editor, match.start, match.end, entry.before);
    syncToolbarVisibility();
    host.notice("已撤销上次 AI 替换");
    return true;
  }

  undoBtn.onclick = () => {
    undoLastReplacement();
  };

  async function triggerRewrite(mode: SelectionRewriteMode): Promise<void> {
    const sel = currentSelection() ?? activeSelection;
    if (!sel) return;
    const state = host.getState();
    const { documentId } = state;
    if (!documentId) return;

    const captured: CapturedSelection = {
      documentId,
      revisionId: state.snapshot.active?.revisionId ?? null,
      start: sel.start,
      end: sel.end,
      text: sel.text,
    };

    let instruction = "";
    if (mode === "custom") {
      const entered = await host.modal.prompt({
        title: "选段微改写指令",
        message: "请输入仅作用于当前选中文本的局部改写要求（严格遵守本章视角人物与锁定设定）。",
        label: "局部改写指令",
        confirmLabel: "生成建议",
      });
      if (!entered?.trim()) return;
      instruction = entered.trim();
    }

    const mySeq = ++requestSeq;
    lastDocumentId = documentId;
    previewCard.replaceChildren(
      el("p", { className: "muted-copy selection-diff-status", text: "正在生成局部微改写建议…" }),
    );
    previewCard.hidden = false;

    const { provider, model } = options.getProviderModel();
    let res: SelectionRewriteResultDto;
    try {
      res = await host.request<SelectionRewriteResultDto>("selection.rewrite", {
        documentId,
        selectedText: captured.text,
        selectionStart: captured.start,
        mode,
        instruction,
        beforeContext: editor.value.slice(Math.max(0, captured.start - 400), captured.start),
        afterContext: editor.value.slice(captured.end, captured.end + 400),
        provider: provider || "default",
        model: model || "default",
      });
    } catch (error) {
      if (mySeq === requestSeq) hidePreview();
      throw error;
    }

    if (mySeq !== requestSeq || host.getState().documentId !== captured.documentId) {
      hidePreview();
      return;
    }

    previewCard.replaceChildren();
    previewCard.hidden = false;
    previewCard.append(el("p", { className: "setting-title", text: `局部微改写对照（消耗 ${res.tokens} tokens）` }));

    const preCheck = resolveCapturedSelection(captured, host.getState().documentId, editor.value);
    if (!preCheck.ok) {
      previewCard.append(
        el("p", { className: "status-warning selection-diff-status", text: failureNoticeForReason(preCheck.reason) }),
      );
    } else if (preCheck.relocated) {
      previewCard.append(
        el("p", { className: "muted-copy selection-diff-status", text: "检测到前文有改动，应用时将自动重定位到原选段。" }),
      );
    }

    const diffBody = el("div", { className: "diff-text" });
    for (const seg of computeInlineDiff(captured.text, res.rewrittenText)) {
      if (seg.kind === "equal") diffBody.append(document.createTextNode(seg.text));
      else if (seg.kind === "removed") diffBody.append(el("del", { className: "diff-char-del", text: seg.text }));
      else diffBody.append(el("ins", { className: "diff-char-ins", text: seg.text }));
    }
    previewCard.append(diffBody);

    const actions = el("div", { className: "actions" });
    const applyBtn = el("button", { className: "primary", text: "应用替换" });
    applyBtn.type = "button";
    applyBtn.dataset.selectionApply = "true";
    applyBtn.onclick = () => {
      const check = resolveCapturedSelection(captured, host.getState().documentId, editor.value);
      if (!check.ok) {
        hidePreview();
        syncToolbarVisibility();
        host.notice(failureNoticeForReason(check.reason), true);
        return;
      }
      applySelectionReplacement(editor, check.start, check.end, res.rewrittenText);
      pushAiUndo({
        documentId: captured.documentId,
        start: check.start,
        before: captured.text,
        after: res.rewrittenText,
      });
      hidePreview();
      activeSelection = null;
      syncToolbarVisibility();
      host.notice("已替换选中片段（可点击“撤销上次 AI 替换”或 Ctrl+Z）");
    };
    const cancelBtn = el("button", { text: "取消" });
    cancelBtn.type = "button";
    cancelBtn.onclick = () => {
      hidePreview();
      syncToolbarVisibility();
    };
    actions.append(applyBtn, cancelBtn);
    previewCard.append(actions);
  }

  for (const [mode, label] of modes) {
    const btn = el("button", { text: label });
    btn.type = "button";
    btn.dataset.selectionMode = mode;
    btn.onclick = () => void host.perform(() => triggerRewrite(mode));
    modeGroup.append(btn);
  }
  bar.append(modeGroup, undoBtn);

  if (hostParent) {
    hostParent.append(bar, previewCard);
  }

  editor.addEventListener("mouseup", syncToolbarVisibility);
  editor.addEventListener("keyup", syncToolbarVisibility);
  editor.addEventListener("select", syncToolbarVisibility);

  return {
    refresh: syncToolbarVisibility,
    hide: hideAll,
    undoLastReplacement,
    getUndoDepth: (docId?: string) => {
      const targetDoc = docId ?? host.getState().documentId;
      return aiUndoStack.filter((entry) => entry.documentId === targetDoc).length;
    },
    destroy(): void {
      editor.removeEventListener("mouseup", syncToolbarVisibility);
      editor.removeEventListener("keyup", syncToolbarVisibility);
      editor.removeEventListener("select", syncToolbarVisibility);
      bar.remove();
      previewCard.remove();
    },
  };
}
