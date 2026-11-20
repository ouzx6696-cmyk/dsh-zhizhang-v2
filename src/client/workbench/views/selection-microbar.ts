import type { SelectionRewriteMode, SelectionRewriteResultDto } from "../../../contracts/workspace-dto.ts";
import { computeInlineDiff, countNonWhitespaceChars } from "../diff.ts";
import { el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";

export interface SelectionMicrobarOptions {
  readonly getProviderModel: () => { readonly provider: string; readonly model: string };
}

/**
 * Replaces the active `[start, end]` range in the `<textarea>` using
 * `setRangeText(..., "select")` and dispatches an `input` event so native
 * `Ctrl+Z` undo, DraftVault stashing, and character counters stay intact.
 */
export function applySelectionReplacement(
  editor: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
): void {
  if (typeof editor.setRangeText === "function") {
    editor.focus?.();
    editor.setRangeText(replacement, start, end, "select");
  } else {
    const val = editor.value;
    editor.value = val.slice(0, start) + replacement + val.slice(end);
    editor.selectionStart = start;
    editor.selectionEnd = start + replacement.length;
  }
  if (typeof Event === "function" && typeof editor.dispatchEvent === "function") {
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function createSelectionMicrobar(
  editor: HTMLTextAreaElement,
  host: WorkbenchShellHost,
  options: SelectionMicrobarOptions,
) {
  const hostParent = editor.parentElement;
  const bar = el("div", { className: "selection-microbar" });
  bar.hidden = true;

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

  function hidePreview(): void {
    previewCard.hidden = true;
    previewCard.replaceChildren();
  }

  function hideAll(): void {
    bar.hidden = true;
    hidePreview();
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
    const sel = currentSelection();
    if (!sel) {
      if (previewCard.hidden) bar.hidden = true;
      return;
    }
    activeSelection = sel;
    bar.hidden = false;
  }

  async function triggerRewrite(mode: SelectionRewriteMode): Promise<void> {
    const sel = currentSelection() ?? activeSelection;
    if (!sel) return;
    const { documentId } = host.getState();
    if (!documentId) return;

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

    const { provider, model } = options.getProviderModel();
    const res = await host.request<SelectionRewriteResultDto>("selection.rewrite", {
      documentId,
      selectedText: sel.text,
      mode,
      instruction,
      beforeContext: editor.value.slice(Math.max(0, sel.start - 400), sel.start),
      afterContext: editor.value.slice(sel.end, sel.end + 400),
      provider: provider || "default",
      model: model || "default",
    });

    previewCard.replaceChildren();
    previewCard.hidden = false;
    previewCard.append(el("p", { className: "setting-title", text: `局部微改写对照（消耗 ${res.tokens} tokens）` }));

    const diffBody = el("div", { className: "diff-text" });
    for (const seg of computeInlineDiff(sel.text, res.rewrittenText)) {
      if (seg.kind === "equal") diffBody.append(document.createTextNode(seg.text));
      else if (seg.kind === "removed") diffBody.append(el("del", { className: "diff-char-del", text: seg.text }));
      else diffBody.append(el("ins", { className: "diff-char-ins", text: seg.text }));
    }
    previewCard.append(diffBody);

    const actions = el("div", { className: "actions" });
    const applyBtn = el("button", { className: "primary", text: "应用替换" });
    applyBtn.type = "button";
    applyBtn.onclick = () => {
      applySelectionReplacement(editor, sel.start, sel.end, res.rewrittenText);
      hideAll();
      host.notice("已替换选中片段（可用 Ctrl+Z 撤销）");
    };
    const cancelBtn = el("button", { text: "取消" });
    cancelBtn.type = "button";
    cancelBtn.onclick = hidePreview;
    actions.append(applyBtn, cancelBtn);
    previewCard.append(actions);
  }

  for (const [mode, label] of modes) {
    const btn = el("button", { text: label });
    btn.type = "button";
    btn.dataset.selectionMode = mode;
    btn.onclick = () => void host.perform(() => triggerRewrite(mode));
    bar.append(btn);
  }

  if (hostParent) {
    hostParent.append(bar, previewCard);
  }

  editor.addEventListener("mouseup", syncToolbarVisibility);
  editor.addEventListener("keyup", syncToolbarVisibility);
  editor.addEventListener("select", syncToolbarVisibility);

  return {
    refresh: syncToolbarVisibility,
    hide: hideAll,
    destroy(): void {
      editor.removeEventListener("mouseup", syncToolbarVisibility);
      editor.removeEventListener("keyup", syncToolbarVisibility);
      editor.removeEventListener("select", syncToolbarVisibility);
      bar.remove();
      previewCard.remove();
    },
  };
}
