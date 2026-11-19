import {
  FANQIE_STAGE_LABELS,
  isLockedDocumentState,
  type ChapterStatusWord,
} from "../../../contracts/workspace.ts";
import { confirmDialog } from "../dialogs.ts";
import { computeParagraphDiff } from "../diff.ts";
import type { WorkbenchStore } from "../store.ts";
import { updateTitleCounter } from "./directory.ts";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function countNonWhitespaceChars(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

function paragraphAtCursor(textarea: HTMLTextAreaElement): number {
  const caret = textarea.selectionStart ?? 0;
  return textarea.value.slice(0, caret).split(/\r?\n/).length;
}

export interface EditorController {
  render(): void;
  saveCurrentDraft(): Promise<void>;
}

export function createEditorView(store: WorkbenchStore): EditorController {
  const editor = byId<HTMLTextAreaElement>("body");
  const emptySection = byId<HTMLElement>("empty");
  const manuscriptSection = byId<HTMLElement>("manuscript");
  const documentLabel = byId<HTMLElement>("document-label");
  const heading = byId<HTMLElement>("heading");
  const stateLabel = byId<HTMLElement>("state");
  const metricsLabel = byId<HTMLElement>("manuscript-metrics");
  const draftStatus = byId<HTMLElement>("draft-status");
  const saveButton = byId<HTMLButtonElement>("save");
  const topSaveButton = document.getElementById("top-save") as HTMLButtonElement | null;
  const renameForm = byId<HTMLFormElement>("rename");
  const titleCount = byId<HTMLElement>("title-count");
  const titleChoices = byId<HTMLSelectElement>("title-choices");
  const comparisonSection = byId<HTMLElement>("comparison");
  const candidateArea = byId<HTMLTextAreaElement>("candidate");
  const candidateQa = byId<HTMLElement>("candidate-qa");
  const diffContainer = byId<HTMLElement>("diff-view");
  const diffSummary = byId<HTMLElement>("diff-summary");
  const diffModeSideBtn = byId<HTMLButtonElement>("diff-mode-side");
  const diffModeInlineBtn = byId<HTMLButtonElement>("diff-mode-inline");
  const adoptButton = byId<HTMLButtonElement>("adopt");
  const discardButton = byId<HTMLButtonElement>("discard");

  let stashTimer: ReturnType<typeof setTimeout> | undefined;
  let lastDiffSignature = "";

  store.bindEditor(
    () => editor.value,
    (value) => {
      editor.value = value;
      updateLiveMetrics();
    },
  );

  function updateLiveMetrics(): void {
    const active = store.snapshot.active;
    if (!active) {
      metricsLabel.textContent = "";
      return;
    }
    const chars = countNonWhitespaceChars(editor.value);
    const point = paragraphAtCursor(editor);
    const revShort = active.revisionId ? `修订 ${active.revisionId.slice(0, 8)}` : "未落库";
    metricsLabel.textContent = `${chars.toLocaleString("zh-Hans")} 字 · 第 ${point} 段 · ${revShort}`;
  }

  function flushStash(): void {
    clearTimeout(stashTimer);
    store.stashCurrentEditor();
  }

  editor.addEventListener("input", () => {
    store.editSequence += 1;
    updateLiveMetrics();
    clearTimeout(stashTimer);
    stashTimer = setTimeout(flushStash, 250);
  });
  editor.addEventListener("keyup", updateLiveMetrics);
  editor.addEventListener("click", updateLiveMetrics);
  editor.addEventListener("compositionstart", () => {
    store.composing = true;
  });
  editor.addEventListener("compositionend", () => {
    store.composing = false;
    flushStash();
  });
  editor.addEventListener("blur", flushStash);
  window.addEventListener("pagehide", flushStash);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushStash();
  });

  async function saveCurrentDraft(): Promise<void> {
    if (!store.snapshot.active || saveButton.disabled) return;
    await store.change("draft.save", { body: editor.value }, { clearDraft: true });
  }

  saveButton.onclick = () => void store.perform(saveCurrentDraft);
  if (topSaveButton) {
    topSaveButton.onclick = () => void store.perform(saveCurrentDraft);
  }

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void store.perform(saveCurrentDraft);
    }
  });

  const renameInput = renameForm.elements.namedItem("title") as HTMLInputElement;
  renameInput.addEventListener("input", () => updateTitleCounter(renameInput, titleCount, true));
  titleChoices.onchange = () => {
    if (titleChoices.value) renameInput.value = titleChoices.value;
    updateTitleCounter(renameInput, titleCount, true);
  };
  renameForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(() =>
      store.change("article.rename", { title: renameInput.value }, { savedVersion: true, clearDraft: true }),
    );
  };

  diffModeSideBtn.onclick = () => store.setDiffMode("side-by-side");
  diffModeInlineBtn.onclick = () => store.setDiffMode("inline");

  adoptButton.onclick = () => {
    void store.perform(async () => {
      const pending = store.candidateRun();
      if (!pending || !pending.candidateId) return;
      const accepted = await confirmDialog({
        title: "采纳候选稿",
        message: "将以这份候选稿覆盖当前工作稿并生成新的修订记录，原修订仍保存在版本历史中。",
        confirmLabel: "采纳并保存新修订",
      });
      if (!accepted) return;
      await store.change(
        "candidate.adopt",
        { key: pending.candidateId, runId: pending.id },
        { clearDraft: true, savedVersion: true, message: "已采纳候选稿" },
      );
    });
  };

  discardButton.onclick = () => {
    void store.perform(async () => {
      const pending = store.candidateRun();
      if (!pending) return;
      await store.change("run.discard", { runId: pending.id }, { message: "已舍弃候选稿" });
    });
  };

  function renderDiff(original: string, candidateBody: string): void {
    const signature = `${store.diffMode}\u0000${original}\u0000${candidateBody}`;
    if (signature === lastDiffSignature) return;
    lastDiffSignature = signature;

    const diff = computeParagraphDiff(original, candidateBody);
    diffSummary.textContent = `未变 ${diff.unchanged} 段 · 修改 ${diff.changed} 段 · 新增 ${diff.added} 段 · 删除 ${diff.removed} 段`;
    diffModeSideBtn.setAttribute("aria-pressed", String(store.diffMode === "side-by-side"));
    diffModeInlineBtn.setAttribute("aria-pressed", String(store.diffMode === "inline"));

    const wrapper = document.createElement("div");
    wrapper.className = store.diffMode === "side-by-side" ? "diff-grid" : "diff-inline";

    if (store.diffMode === "side-by-side") {
      const head = document.createElement("div");
      head.className = "diff-grid-head";
      const hLeft = document.createElement("span");
      hLeft.textContent = "当前工作稿";
      const hRight = document.createElement("span");
      hRight.textContent = "候选稿";
      head.append(hLeft, hRight);
      wrapper.append(head);

      for (const row of diff.rows) {
        const line = document.createElement("div");
        line.className = `diff-row diff-${row.kind}`;

        const leftCell = document.createElement("div");
        leftCell.className = "diff-cell diff-left";
        const leftNum = document.createElement("span");
        leftNum.className = "diff-num";
        leftNum.textContent = row.leftIndex !== null ? String(row.leftIndex) : "";
        const leftBody = document.createElement("span");
        leftBody.className = "diff-text";
        leftBody.textContent = row.leftText || (row.kind === "added" ? "—" : "");
        leftCell.append(leftNum, leftBody);

        const rightCell = document.createElement("div");
        rightCell.className = "diff-cell diff-right";
        const rightNum = document.createElement("span");
        rightNum.className = "diff-num";
        rightNum.textContent = row.rightIndex !== null ? String(row.rightIndex) : "";
        const rightBody = document.createElement("span");
        rightBody.className = "diff-text";
        rightBody.textContent = row.rightText || (row.kind === "removed" ? "—" : "");
        rightCell.append(rightNum, rightBody);

        line.append(leftCell, rightCell);
        wrapper.append(line);
      }
    } else {
      for (const row of diff.rows) {
        if (row.kind === "equal") {
          const item = document.createElement("div");
          item.className = "diff-inline-row diff-equal";
          item.textContent = `  ${row.leftText}`;
          wrapper.append(item);
        } else if (row.kind === "removed" || row.kind === "changed") {
          const del = document.createElement("div");
          del.className = "diff-inline-row diff-removed";
          del.textContent = `− ${row.leftText}`;
          wrapper.append(del);
          if (row.kind === "changed") {
            const add = document.createElement("div");
            add.className = "diff-inline-row diff-added";
            add.textContent = `+ ${row.rightText}`;
            wrapper.append(add);
          }
        } else {
          const add = document.createElement("div");
          add.className = "diff-inline-row diff-added";
          add.textContent = `+ ${row.rightText}`;
          wrapper.append(add);
        }
      }
    }

    diffContainer.replaceChildren(wrapper);
  }

  function render(): void {
    const snapshot = store.snapshot;
    const active = snapshot.active;
    const article = active?.product === "toutiao";
    const hasDraft = Boolean(active?.revisionId);
    const locked = isLockedDocumentState(active?.state);

    emptySection.hidden = Boolean(active);
    manuscriptSection.hidden = !active;
    if (topSaveButton) topSaveButton.disabled = !active || locked;
    if (!active) {
      metricsLabel.textContent = "";
      return;
    }

    documentLabel.textContent = article ? "头条创作" : "番茄连载";
    heading.textContent = active.title || "微头条";
    stateLabel.textContent =
      (FANQIE_STAGE_LABELS as Record<string, string>)[active.state as ChapterStatusWord] ?? active.state;

    const saved = store.vault.read(active.id);
    const stale = Boolean(saved && saved.revisionId !== active.revisionId);
    const visibleBody = saved?.body ?? active.body ?? "";
    if (editor.value !== visibleBody && !store.composing) {
      editor.value = visibleBody;
    }
    editor.readOnly = locked || stale;
    saveButton.disabled = locked || stale;
    if (topSaveButton) topSaveButton.disabled = locked || stale;

    updateLiveMetrics();

    draftStatus.replaceChildren(
      document.createTextNode(
        stale
          ? "有一份基于旧版本的本地编辑。"
          : saved
            ? "已恢复本地编辑"
            : hasDraft
              ? "已保存"
              : "尚未保存",
      ),
    );
    draftStatus.dataset.tone = stale ? "danger" : saved ? "warning" : "normal";

    if (stale) {
      const conflictActions = document.createElement("div");
      conflictActions.className = "conflict-bar";

      const compare = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "查看服务器正文";
      const serverPre = document.createElement("pre");
      serverPre.textContent = active.body ?? "";
      compare.append(summary, serverPre);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "复制本地稿";
      copyBtn.onclick = () => {
        void store.perform(async () => {
          await navigator.clipboard.writeText(editor.value);
          store.setNotice("已复制本地稿");
        });
      };

      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "danger-outline";
      restoreBtn.textContent = "使用服务器版本";
      restoreBtn.onclick = () => {
        void store.perform(async () => {
          const ok = await confirmDialog({
            title: "采用服务器版本",
            message: "确认丢弃这份基于旧版本的本地编辑并载入服务器最新正文？建议先点击「复制本地稿」留底。",
            confirmLabel: "丢弃本地编辑",
            danger: true,
          });
          if (!ok) return;
          store.vault.write(active.id, null);
          store.notify();
        });
      };

      conflictActions.append(compare, copyBtn, restoreBtn);
      draftStatus.append(conflictActions);
    }

    renameForm.hidden = !article || active.mode === "micro" || locked;
    if (renameForm.dataset.title !== active.title) {
      renameForm.dataset.title = active.title;
      renameInput.value = active.title;
    }
    updateTitleCounter(renameInput, titleCount, !renameForm.hidden);

    const plannedTitles = snapshot.planning?.titleMatrix?.valid.map(({ text }) => text) ?? [];
    const serializedTitles = JSON.stringify(plannedTitles);
    if (titleChoices.dataset.titles !== serializedTitles) {
      titleChoices.dataset.titles = serializedTitles;
      titleChoices.replaceChildren(
        new Option("选择候选标题", ""),
        ...plannedTitles.map((title) => new Option(title, title)),
      );
    }

    const pending = store.candidateRun();
    comparisonSection.hidden = !pending || locked;
    if (pending && !locked) {
      const candidateBody = pending.candidateBody ?? "";
      candidateArea.value = candidateBody;
      renderDiff(active.body ?? "", candidateBody);
      const parsedQa = pending.candidateQa
        ? (JSON.parse(pending.candidateQa) as {
            overall: number;
            fails: string[];
            hardGates: string[];
          })
        : undefined;
      candidateQa.hidden = !parsedQa;
      candidateQa.textContent = parsedQa
        ? [
            `候选稿质检 ${parsedQa.overall} 分 · 回改 ${pending.refinementRounds ?? 0} 轮`,
            ...parsedQa.fails,
            ...parsedQa.hardGates,
          ].join(" · ")
        : "";
      adoptButton.disabled = pending.baseRevisionId !== active.revisionId;
    }
  }

  return { render, saveCurrentDraft };
}
