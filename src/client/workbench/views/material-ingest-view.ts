import type {
  MaterialChunkRole,
  MaterialCommitSummaryDto,
  MaterialIngestSessionDto,
  MaterialProposedBundleDto,
} from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

const ROLE_OPTIONS: readonly { readonly value: MaterialChunkRole; readonly label: string }[] = [
  { value: "completed_chapter", label: "已完成正文" },
  { value: "rough_draft", label: "草稿/残章" },
  { value: "lore_note", label: "设定笔记" },
  { value: "outline_note", label: "大纲/指南针" },
  { value: "foreshadow_note", label: "伏笔/时间线" },
  { value: "ignore", label: "忽略不入库" },
];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  chunked: "已本地切片，待提炼或预览",
  extracting: "AI 深度标准化提炼中",
  ready_for_review: "标准化提案就绪，待预览入库",
  committed: "已完成原子入库",
  discarded: "已废弃",
  failed: "提炼失败",
};

const CHAPTER_CONFLICT_LABELS: Readonly<Record<string, string>> = {
  new: "新建章节",
  update_draft: "覆盖未定稿草稿",
  skip_locked_final: "已定稿跳过保护",
};

const LORE_CONFLICT_LABELS: Readonly<Record<string, string>> = {
  new: "新建设定",
  update_unlocked: "更新未锁定设定",
  skip_locked: "已锁定保护跳过",
};

type PreviewTab = "chapters" | "lore" | "foreshadows" | "compass";

/**
 * 3-Stage Non-Standard Material Normalization & Re-Ingestion Studio (`zhizhang/3.0`).
 * Stage 1: Zero-token local cleaning, splitting, role tagging & duplicate detection.
 * Stage 2: AI structured extraction (reusing L0+L1 cache) or DsH Agent pushed bundle, plus offline baseline preview.
 * Stage 3: 4-tab diff preview with locked-lore / final-chapter protection & atomic SQLite commit.
 */
export function createMaterialIngestView(container: HTMLElement, host: WorkbenchShellHost) {
  let sessions: readonly MaterialIngestSessionDto[] = [];
  let activeSessionId = "";
  let activeSession: MaterialIngestSessionDto | null = null;
  let editableChunks: Array<{ id: string; title: string; role: MaterialChunkRole; charCount: number; sourcePath: string; duplicateOfExistingTitle?: string | null; warnings: readonly string[] }> = [];
  let workingBundle: MaterialProposedBundleDto | null = null;
  let previewTab: PreviewTab = "chapters";
  let showStage3 = false;
  let pasteText = "";
  let pasteFilename = "手写设定与草稿合集.md";
  let uploadedFiles: Array<{ path: string; content: string }> = [];
  let lastCommit: MaterialCommitSummaryDto | null = null;
  let pollTimer: number | null = null;

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function syncWorkingState(session: MaterialIngestSessionDto | null): void {
    activeSession = session;
    activeSessionId = session?.id ?? "";
    editableChunks = (session?.chunks ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      role: c.role,
      charCount: c.charCount,
      sourcePath: c.sourcePath,
      duplicateOfExistingTitle: c.duplicateOfExistingTitle,
      warnings: c.warnings,
    }));
    workingBundle = session?.proposedBundle
      ? (JSON.parse(JSON.stringify(session.proposedBundle)) as MaterialProposedBundleDto)
      : null;
    if (session?.status === "ready_for_review") {
      showStage3 = true;
    }
    if (session?.committedReport) {
      lastCommit = session.committedReport;
    }
    if (session?.status === "extracting") {
      if (pollTimer === null) {
        pollTimer = window.setInterval(() => {
          void loadSessions(true);
        }, 2500);
      }
    } else {
      stopPolling();
    }
  }

  async function loadSessions(silent = false): Promise<void> {
    const { projectId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    if (!project || project.product !== "fanqie") {
      stopPolling();
      sessions = [];
      syncWorkingState(null);
      paint();
      return;
    }
    try {
      const list = await host.request<readonly MaterialIngestSessionDto[]>("material.list", {
        projectId,
        limit: 10,
      });
      sessions = list;
      const target = list.find((s) => s.id === activeSessionId) ?? list[0] ?? null;
      syncWorkingState(target);
      paint();
    } catch {
      if (!silent) paint();
    }
  }

  function paint(): void {
    const { projectId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    container.replaceChildren();

    if (!project || project.product !== "fanqie") {
      container.append(
        createCard({
          tag: "section",
          variant: "default",
          padding: "md",
          title: "非标准材料转标准材料重写入（AI + DsH 协作）",
          body: el("p", {
            className: "muted-copy",
            text: "请先打开一个番茄连载项目，即可将杂乱设定笔记、草稿与已完成正文通过“本地清洗切片 → AI/DsH 提炼 → 四栏预览原子入库”转为织章标准资产。",
          }),
        }),
      );
      return;
    }

    const bodyNodes: HTMLElement[] = [];

    bodyNodes.push(
      el("p", {
        className: "muted-copy",
        text: "支持直接上传多份 .txt / .md 或粘贴混合材料（设定笔记 + 草稿 + 已完成章节）。阶段一完全零 Token 在本地去噪切分，阶段二支持 AI 深度提炼或 DsH Agent 外部工具提交，阶段三经四栏差异核对后原子入库并重建 L1 圣经快照。",
      }),
    );

    // Stage 1: Upload / Paste input
    const uploadWrap = el("div", { className: "ingest-stage-block" });
    uploadWrap.append(el("h4", { className: "inspector-heading", text: "1. 导入非标准材料（零 Token 本地清洗与切片）" }));

    const fileLabel = el("label", { className: "ui-field" });
    fileLabel.append(el("span", { className: "ui-field-label", text: "选择一份或多份 .txt / .md 原始文件" }));
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "ui-input";
    fileInput.multiple = true;
    fileInput.accept = ".txt,.md,text/plain,text/markdown";
    fileInput.onchange = () => {
      const selected = Array.from(fileInput.files ?? []);
      if (selected.length === 0) return;
      void host.perform(async () => {
        uploadedFiles = [];
        for (const f of selected) {
          uploadedFiles.push({ path: f.name, content: await f.text() });
        }
        host.notice(`已载入 ${uploadedFiles.length} 份本地材料，可点击下方按钮开始零 Token 切片`);
        paint();
      });
    };
    fileLabel.append(fileInput);
    uploadWrap.append(fileLabel);

    if (uploadedFiles.length > 0) {
      uploadWrap.append(
        el("p", {
          className: "setting-meta tabular",
          text: `已选待处理文件（${uploadedFiles.length} 份）：${uploadedFiles.map((f) => `${f.path}（${f.content.length}字）`).join(" · ")}`,
        }),
      );
    }

    const nameField = createInput({
      label: "快速粘贴来源标识",
      name: "ingestSourceName",
      value: pasteFilename,
      placeholder: "例如：世界观备忘与前两章草稿.md",
      onInput: (val) => {
        pasteFilename = val;
      },
    });
    const pasteField = createInput({
      kind: "textarea",
      label: "或直接粘贴原始设定、大纲、草稿或已写正文",
      name: "ingestPasteText",
      rows: 5,
      value: pasteText,
      placeholder: "示例：\n# 人物设定\n沈砚：寒门庶子，性格隐忍克制，随身佩带半枚青铜玉玦。\n\n第1章 雨夜来客\n雨水顺着青瓦砸在阶前……",
      onInput: (val) => {
        pasteText = val;
      },
    });
    uploadWrap.append(nameField.root, pasteField.root);

    const stage1Actions = el("div", { className: "actions" });
    stage1Actions.append(
      createButton({
        label: "开始零 Token 本地切片与清洗",
        variant: "primary",
        onClick: () =>
          void host.perform(async () => {
            const files: { path: string; content: string }[] = [...uploadedFiles];
            if (pasteText.trim()) {
              files.push({ path: pasteFilename.trim() || "粘贴材料.md", content: pasteText });
            }
            if (files.length === 0) {
              throw new Error("请先选择 .txt/.md 文件或粘贴原始材料内容。");
            }
            const session = await host.request<MaterialIngestSessionDto>("material.preprocess", {
              projectId,
              files,
            });
            uploadedFiles = [];
            pasteText = "";
            showStage3 = false;
            lastCommit = null;
            host.notice(`本地切片完成：共识别 ${session.chunks.length} 个语义片段（${session.totalChars.toLocaleString("zh-Hans")} 字）`);
            activeSessionId = session.id;
            await loadSessions(false);
          }),
      }),
      createButton({
        label: "刷新会话列表",
        variant: "secondary",
        onClick: () => void loadSessions(false),
      }),
    );
    uploadWrap.append(stage1Actions);
    bodyNodes.push(uploadWrap);

    // Session selector (includes DsH Agent pushed sessions!)
    if (sessions.length > 0) {
      const switcherWrap = el("div", { className: "ingest-stage-block" });
      const selField = createInput({
        kind: "select",
        label: "选择待处理会话（包含工作台上传与 DsH Agent 提交会话）",
        name: "ingestSessionSelect",
        value: activeSessionId,
        options: sessions.map((s) => ({
          value: s.id,
          label: `[${s.sourceOrigin === "dsh_agent" ? "DsH Agent" : "本地上传"}] ${STATUS_LABELS[s.status] ?? s.status} · ${s.chunks.length} 片段 · ${s.totalChars} 字`,
        })),
        onChange: (val) => {
          const found = sessions.find((s) => s.id === val) ?? null;
          showStage3 = found?.status === "ready_for_review";
          syncWorkingState(found);
          paint();
        },
      });
      switcherWrap.append(selField.root);
      bodyNodes.push(switcherWrap);
    }

    // Active session Stage 1 review + Stage 2 triggers
    if (activeSession) {
      const session = activeSession;
      const chunkBlock = el("div", { className: "ingest-stage-block" });
      chunkBlock.append(
        el("h4", {
          className: "inspector-heading tabular",
          text: `2. 切片校核与标准化提炼 · 状态：${STATUS_LABELS[session.status] ?? session.status} · 共 ${editableChunks.length} 个片段`,
        }),
      );

      if (session.cleaningWarnings.length > 0) {
        chunkBlock.append(
          el("p", {
            className: "status-warning",
            text: `清洗提示：${session.cleaningWarnings.join(" · ")}`,
          }),
        );
      }
      if (session.error) {
        chunkBlock.append(el("p", { className: "status-warning", text: `最近错误：${session.error}` }));
      }

      const chunkList = el("div", { className: "ingest-chunk-list" });
      for (const ch of editableChunks) {
        const row = el("div", { className: "ingest-chunk-row" });

        const roleSelect = document.createElement("select");
        roleSelect.className = "ui-input ui-select ingest-role-select";
        roleSelect.setAttribute("aria-label", `片段角色：${ch.title}`);
        for (const opt of ROLE_OPTIONS) {
          const optionEl = document.createElement("option");
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          roleSelect.append(optionEl);
        }
        roleSelect.value = ch.role;
        roleSelect.disabled = session.status === "committed" || session.status === "discarded";
        roleSelect.onchange = () => {
          ch.role = roleSelect.value as MaterialChunkRole;
        };

        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.className = "ui-input ingest-title-input";
        titleInput.value = ch.title;
        titleInput.setAttribute("aria-label", `片段标题：${ch.title}`);
        titleInput.disabled = session.status === "committed" || session.status === "discarded";
        titleInput.oninput = () => {
          ch.title = titleInput.value;
        };

        const metaText = [
          ch.sourcePath,
          `${ch.charCount.toLocaleString("zh-Hans")} 字`,
          ch.duplicateOfExistingTitle ? `疑似同名「${ch.duplicateOfExistingTitle}」` : "",
          ...ch.warnings,
        ]
          .filter(Boolean)
          .join(" · ");
        const meta = el("span", {
          className: ch.duplicateOfExistingTitle ? "setting-meta status-warning tabular" : "setting-meta tabular",
          text: metaText,
        });

        row.append(roleSelect, titleInput, meta);
        chunkList.append(row);
      }
      chunkBlock.append(chunkList);

      const isEditable = session.status !== "committed" && session.status !== "discarded";
      if (isEditable) {
        const stage2Actions = el("div", { className: "actions" });
        stage2Actions.append(
          createButton({
            label: "保存切片调整",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                const updated = await host.request<MaterialIngestSessionDto>("material.update_chunks", {
                  sessionId: session.id,
                  chunks: editableChunks.map((c) => ({ id: c.id, role: c.role, title: c.title.trim() || c.title })),
                });
                syncWorkingState(updated);
                host.notice("已更新切片角色与标题并重建本地基线提案");
                paint();
              }),
          }),
          createButton({
            label: "AI 深度标准化提炼（复用 L0+L1 缓存）",
            variant: "secondary",
            size: "sm",
            disabled: session.status === "extracting",
            onClick: () =>
              void host.perform(async () => {
                await host.request("material.extract", {
                  sessionId: session.id,
                });
                host.notice("已提交 AI 深度标准化提炼任务，完成后将自动刷新预览");
                await loadSessions(false);
              }),
          }),
          createButton({
            label: "直接使用本地基线预览",
            variant: "primary",
            size: "sm",
            onClick: () => {
              showStage3 = true;
              paint();
            },
          }),
          createButton({
            label: "废弃此会话",
            variant: "danger",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("material.discard", { sessionId: session.id });
                host.notice("已废弃该材料导入会话");
                showStage3 = false;
                await loadSessions(false);
              }),
          }),
        );
        chunkBlock.append(stage2Actions);
      }
      bodyNodes.push(chunkBlock);

      // Stage 3: 4-tab diff preview & atomic commit
      if (showStage3 && workingBundle && session.status !== "discarded") {
        const bundle = workingBundle;
        const previewBlock = el("div", { className: "ingest-stage-block" });
        previewBlock.append(
          el("h4", {
            className: "inspector-heading tabular",
            text: `3. 四栏标准化差异预览与原子入库（章节 ${bundle.chapters.length} · 设定 ${bundle.lore.length} · 伏笔 ${bundle.foreshadows.length}）`,
          }),
        );

        const tabBar = el("div", { className: "segmented ingest-tabs" });
        for (const [id, label] of [
          ["chapters", `卷幕章节 (${bundle.chapters.length})`],
          ["lore", `标准化设定 (${bundle.lore.length})`],
          ["foreshadows", `伏笔与时间线 (${bundle.foreshadows.length})`],
          ["compass", "全书指南针"],
        ] as const) {
          tabBar.append(
            createButton({
              label,
              variant: "ghost",
              size: "sm",
              active: previewTab === id,
              pressed: previewTab === id,
              onClick: () => {
                previewTab = id;
                paint();
              },
            }),
          );
        }
        previewBlock.append(tabBar);

        const tabPanel = el("div", { className: "ingest-tab-panel" });
        const committed = session.status === "committed";

        if (previewTab === "chapters") {
          if (bundle.chapters.length === 0) {
            tabPanel.append(el("p", { className: "muted-copy", text: "本次材料未包含章节正文或草稿。" }));
          } else {
            for (const ch of bundle.chapters) {
              const row = el("div", { className: "ingest-preview-row" });
              const lbl = el("label", { className: "diff-check-label" });
              const cb = document.createElement("input");
              cb.type = "checkbox";
              cb.checked = ch.selected && ch.conflictStatus !== "skip_locked_final";
              cb.disabled = committed || ch.conflictStatus === "skip_locked_final";
              cb.onchange = () => {
                (ch as { selected: boolean }).selected = cb.checked;
              };
              const conflictLabel = CHAPTER_CONFLICT_LABELS[ch.conflictStatus] ?? ch.conflictStatus;
              lbl.append(
                cb,
                document.createTextNode(`${ch.volumeTitle} / ${ch.actTitle} / ${ch.title}`),
              );
              row.append(
                lbl,
                el("p", {
                  className: ch.conflictStatus === "skip_locked_final" ? "status-warning tabular" : "setting-meta tabular",
                  text: `${conflictLabel} · 目标状态 ${ch.state} · ${ch.body.length.toLocaleString("zh-Hans")} 字${ch.summary ? ` · 摘要：${ch.summary.slice(0, 70)}` : ""}`,
                }),
              );
              tabPanel.append(row);
            }
          }
        } else if (previewTab === "lore") {
          if (bundle.lore.length === 0) {
            tabPanel.append(el("p", { className: "muted-copy", text: "本次材料未提炼出待入库设定条目。" }));
          } else {
            for (const item of bundle.lore) {
              const row = el("div", { className: "ingest-preview-row" });
              const lbl = el("label", { className: "diff-check-label" });
              const cb = document.createElement("input");
              cb.type = "checkbox";
              cb.checked = item.selected && item.conflictStatus !== "skip_locked";
              cb.disabled = committed || item.conflictStatus === "skip_locked";
              cb.onchange = () => {
                (item as { selected: boolean }).selected = cb.checked;
              };
              lbl.append(cb, document.createTextNode(`${item.entityName}（${item.factId}）`));
              const conflictLabel = LORE_CONFLICT_LABELS[item.conflictStatus] ?? item.conflictStatus;
              row.append(
                lbl,
                el("p", {
                  className: item.conflictStatus === "skip_locked" ? "status-warning" : "setting-meta",
                  text: [
                    item.category,
                    conflictLabel,
                    item.lockedSuggested ? "建议锁定" : "",
                    item.aliases.length > 0 ? `别名：${item.aliases.join("、")}` : "",
                    item.conflictNote ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }),
                el("p", { className: "setting-meta", text: item.note }),
              );
              tabPanel.append(row);
            }
          }
        } else if (previewTab === "foreshadows") {
          if (bundle.foreshadows.length === 0) {
            tabPanel.append(el("p", { className: "muted-copy", text: "本次材料未提炼出伏笔条目。" }));
          } else {
            for (const fs of bundle.foreshadows) {
              const row = el("div", { className: "ingest-preview-row" });
              const lbl = el("label", { className: "diff-check-label" });
              const cb = document.createElement("input");
              cb.type = "checkbox";
              cb.checked = fs.selected;
              cb.disabled = committed;
              cb.onchange = () => {
                (fs as { selected: boolean }).selected = cb.checked;
              };
              lbl.append(cb, document.createTextNode(fs.title));
              row.append(
                lbl,
                el("p", {
                  className: "setting-meta",
                  text: [
                    `状态 ${fs.status}`,
                    fs.plantedChapterTitle ? `埋设：${fs.plantedChapterTitle}` : "",
                    fs.targetChapterTitle ? `计划回收：${fs.targetChapterTitle}` : "",
                    fs.note,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }),
              );
              tabPanel.append(row);
            }
          }
        } else {
          const lines = [
            bundle.authorIntent ? `全书核心意图：${bundle.authorIntent}` : "全书核心意图：保持当前项目设定不变",
            bundle.currentFocus ? `当前阶段重心：${bundle.currentFocus}` : "当前阶段重心：保持当前项目设定不变",
            bundle.pacingTier ? `推荐节奏档位：${bundle.pacingTier}` : "",
            bundle.genreTags && bundle.genreTags.length > 0 ? `题材标签：${bundle.genreTags.join("、")}` : "",
          ].filter(Boolean);
          for (const line of lines) {
            tabPanel.append(el("p", { className: "setting-meta", text: line }));
          }
          if (bundle.warnings.length > 0) {
            tabPanel.append(
              el("p", { className: "status-warning", text: `提案注意事项：${bundle.warnings.join(" · ")}` }),
            );
          }
        }
        previewBlock.append(tabPanel);

        if (!committed) {
          const commitActions = el("div", { className: "actions" });
          commitActions.append(
            createButton({
              label: "确认无误，原子入库并重建 L1 圣经快照",
              variant: "primary",
              onClick: () =>
                void host.perform(async () => {
                  const summary = await host.request<MaterialCommitSummaryDto>("material.commit", {
                    sessionId: session.id,
                    bundle: workingBundle,
                  });
                  lastCommit = summary;
                  host.notice(
                    `原子入库完成：新建 ${summary.chaptersCreated} 章，更新 ${summary.chaptersUpdated} 章，入库设定 ${summary.loreCommitted} 条，L1 快照升至 v${summary.l1SnapshotVersion}`,
                  );
                  await host.load();
                  await loadSessions(false);
                }),
            }),
          );
          previewBlock.append(commitActions);
        }

        bodyNodes.push(previewBlock);
      }
    }

    if (lastCommit) {
      const s = lastCommit;
      bodyNodes.push(
        el("p", {
          className: "qa-summary tabular",
          text: `最近一次重写入汇总：新建卷 ${s.volumesCreated} · 幕 ${s.actsCreated} · 新建章 ${s.chaptersCreated} · 更新章 ${s.chaptersUpdated} · 定稿保护跳过 ${s.chaptersSkippedLocked} · 入库设定 ${s.loreCommitted}（锁定跳过 ${s.loreSkippedLocked}） · 伏笔 ${s.foreshadowsCommitted} · L1 圣经快照 v${s.l1SnapshotVersion}`,
        }),
      );
    }

    container.append(
      createCard({
        tag: "section",
        variant: "default",
        padding: "md",
        title: "非标准材料转标准材料重写入（AI + DsH 协作）",
        body: bodyNodes,
        className: "ingest-wizard",
      }),
    );
  }

  return {
    refresh: () => void loadSessions(false),
    clear: () => {
      stopPolling();
      container.replaceChildren();
    },
  };
}
