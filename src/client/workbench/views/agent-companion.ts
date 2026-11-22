import type {
  AgentDraftWriteDto,
  CollaborationMode,
  CollaborationSystemPromptDto,
  WorkspaceSnapshot,
} from "../../../contracts/workspace-dto.ts";
import { computeParagraphDiff } from "../diff.ts";
import { byId, el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { createButton, createCard } from "../ui/primitives.ts";

export interface AgentHandoffBrief {
  readonly title: string;
  readonly prompt: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

type HandoffListener = (brief: AgentHandoffBrief) => void;
const handoffListeners = new Set<HandoffListener>();

export function onAgentHandoff(listener: HandoffListener): () => void {
  handoffListeners.add(listener);
  return () => {
    handoffListeners.delete(listener);
  };
}

/**
 * Dispatches a structured task brief to the parent DsH conversation host via
 * `postMessage` and copies it to clipboard as a reliable fallback.
 */
export function dispatchAgentHandoff(brief: AgentHandoffBrief): void {
  try {
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      window.parent.postMessage(
        {
          type: "zhizhang:handoff",
          title: brief.title,
          prompt: brief.prompt,
          context: brief.context ?? {},
        },
        "*",
      );
    }
  } catch {
    // Ignore cross-origin postMessage restrictions when hosted outside DsH.
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(brief.prompt).catch(() => {});
    }
  } catch {
    // Clipboard access may be denied in headless or restricted iframes.
  }
  for (const listener of handoffListeners) {
    listener(brief);
  }
}

export interface AgentCompanionOptions {
  readonly companionContainer: HTMLElement;
  readonly writeBannerContainer: HTMLElement;
  readonly handoffStripContainer: HTMLElement;
  readonly host: WorkbenchShellHost;
  readonly onClearLocalDraft: (documentId: string) => void;
}

export function createAgentCompanion(options: AgentCompanionOptions) {
  const { companionContainer, writeBannerContainer, handoffStripContainer, host, onClearLocalDraft } = options;

  let lastSnapshot: WorkspaceSnapshot = {};
  let dismissedWriteId: string | null = null;
  let showWriteDiff = false;
  let promptPreview: CollaborationSystemPromptDto | null = null;
  let activeHandoff: AgentHandoffBrief | null = null;

  function renderHandoffStrip(): void {
    handoffStripContainer.replaceChildren();
    if (!activeHandoff) {
      handoffStripContainer.hidden = true;
      return;
    }
    handoffStripContainer.hidden = false;

    const head = el("div", { className: "agent-strip-head" });
    const titleWrap = el("div");
    titleWrap.append(
      el("p", { className: "setting-title", text: `已交办给 DsH Agent · ${activeHandoff.title}` }),
      el("p", {
        className: "muted-copy",
        text: "任务指令已派发至 DsH 对话宿主并复制到剪贴板，可直接发送给 Agent 执行。",
      }),
    );

    const actions = el("div", { className: "actions" });
    actions.append(
      createButton({
        label: "复制指令",
        variant: "secondary",
        size: "sm",
        onClick: () => {
          if (!activeHandoff) return;
          void navigator.clipboard?.writeText(activeHandoff.prompt).catch(() => {});
          host.notice("已复制交办指令到剪贴板");
        },
      }),
      createButton({
        label: "收起",
        variant: "ghost",
        size: "sm",
        onClick: () => {
          activeHandoff = null;
          renderHandoffStrip();
        },
      }),
    );
    head.append(titleWrap, actions);

    const details = document.createElement("details");
    details.className = "disclosure";
    const summary = document.createElement("summary");
    summary.textContent = "查看交办指令全文";
    const pre = el("pre", { className: "server-body-preview", text: activeHandoff.prompt });
    details.append(summary, pre);

    handoffStripContainer.append(head, details);
  }

  onAgentHandoff((brief) => {
    activeHandoff = brief;
    renderHandoffStrip();
    host.notice(`已交办给 DsH Agent：${brief.title}`);
  });

  function renderWriteBanner(snapshot: WorkspaceSnapshot): void {
    writeBannerContainer.replaceChildren();
    const active = snapshot.active;
    const latest: AgentDraftWriteDto | null | undefined = snapshot.latestAgentWrite;
    const isDirectActive = Boolean(
      active &&
      latest &&
      latest.documentId === active.id &&
      latest.mode === "direct_write" &&
      !latest.rolledBack &&
      latest.id !== dismissedWriteId &&
      active.state !== "final" &&
      active.state !== "已验收" &&
      active.state !== "已交稿",
    );

    if (!isDirectActive || !latest || !active) {
      writeBannerContainer.hidden = true;
      showWriteDiff = false;
      return;
    }

    writeBannerContainer.hidden = false;
    const header = el("div", { className: "agent-strip-head" });
    const info = el("div");
    info.append(
      el("p", { className: "setting-title", text: "DsH Agent 已在共创模式下直写本章草稿" }),
      el("p", {
        className: "muted-copy",
        text: `${latest.summary || "已自动保留前序版本快照"} · 可随时对照差异或一键撤销回滚。`,
      }),
    );

    const actions = el("div", { className: "actions" });
    actions.append(
      createButton({
        label: showWriteDiff ? "隐藏变更对比" : "查看变更对比",
        variant: "secondary",
        size: "sm",
        onClick: () => {
          showWriteDiff = !showWriteDiff;
          renderWriteBanner(lastSnapshot);
        },
      }),
      createButton({
        label: "一键撤销回滚",
        variant: "danger",
        size: "sm",
        onClick: () =>
          void host.perform(async () => {
            await host.request("agent.rollback_write", { writeId: latest.id });
            onClearLocalDraft(active.id);
            showWriteDiff = false;
            await host.load();
            host.notice("已撤销 Agent 本次写入并恢复至前序版本快照");
          }),
      }),
      createButton({
        label: "确认保留",
        variant: "ghost",
        size: "sm",
        onClick: () => {
          dismissedWriteId = latest.id;
          showWriteDiff = false;
          renderWriteBanner(lastSnapshot);
        },
      }),
    );
    header.append(info, actions);
    writeBannerContainer.append(header);

    if (showWriteDiff) {
      const diffBox = el("div", { className: "agent-write-diff" });
      const summary = computeParagraphDiff(latest.previousBody ?? "", active.body ?? "");
      const changedRows = summary.rows.filter((r) => r.kind !== "equal" && (r.leftText.trim() || r.rightText.trim()));
      if (changedRows.length === 0) {
        diffBox.append(el("p", { className: "muted-copy", text: "当前正文与写入前快照无段落差异。" }));
      } else {
        for (const row of changedRows.slice(0, 24)) {
          const item = el("div", { className: `agent-diff-line agent-diff-${row.kind}` });
          if (row.leftText) {
            item.append(el("p", { className: "agent-diff-old", text: `- ${row.leftText}` }));
          }
          if (row.rightText) {
            item.append(el("p", { className: "agent-diff-new", text: `+ ${row.rightText}` }));
          }
          diffBox.append(item);
        }
      }
      writeBannerContainer.append(diffBox);
    }
  }

  function buildQuickActions(snapshot: WorkspaceSnapshot): HTMLElement {
    const active = snapshot.active!;
    const { projectId } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    const projectTitle = project?.name ?? "当前作品";
    const modeLabel = snapshot.collaborationMode === "co_create" ? "共创模式（可直写工作草稿）" : "审慎模式（落候选区审批）";
    const grid = el("div", { className: "agent-action-grid" });

    if (active.product === "fanqie") {
      const actions: ReadonlyArray<{
        readonly label: string;
        readonly primary?: boolean;
        readonly title: string;
        readonly prompt: string;
      }> = [
        {
          label: "交办续写本章",
          primary: true,
          title: `续写《${active.title}》`,
          prompt: [
            `请协助续写小说《${projectTitle}》当前章节《${active.title}》（projectId=${projectId}, documentId=${active.id}）。`,
            `当前协作模式：${modeLabel}。`,
            "请按以下协同步骤执行：",
            "1. 先调用 `zhizhang_read_context` 拉取本章四层上下文（L1设定圣经/L2卷幕里程碑/L3近章与视角边界）；",
            "2. 查看系统提示词中的技法目录，按需调用 `zhizhang_load_skill` 加载核心技法全文；",
            "3. 紧扣上文与章纲完成续写后，调用 `zhizhang_submit_draft` 交付正文，并简述所用技法与自检结果。",
          ].join("\n"),
        },
        {
          label: "交办按技法精修",
          title: `按技法精修《${active.title}》`,
          prompt: [
            `请对《${projectTitle}》章节《${active.title}》（documentId=${active.id}）执行按技法精修。`,
            "1. 调用 `zhizhang_read_chapter` 与 `zhizhang_list_skills` 查看当前正文与本章推荐/置顶技法；",
            "2. 用 `zhizhang_load_skill` 加载目标技法细则与正反例；",
            "3. 仅针对需要打磨的段落调用 `zhizhang_patch_paragraphs` 进行外科手术式精修，保留其余段落不动。",
          ].join("\n"),
        },
        {
          label: "交办诊断修复",
          title: `诊断并修复《${active.title}》`,
          prompt: [
            `请对《${projectTitle}》章节《${active.title}》（projectId=${projectId}, documentId=${active.id}）进行全量体检并修复问题段落：`,
            "1. 调用 `zhizhang_diagnose_chapter` 与 `zhizhang_check_conflicts` 获取去AI味、视角越权、黄金三章与时间线诊断；",
            "2. 对命中的问题段落调用 `zhizhang_patch_paragraphs` 定点修改。",
          ].join("\n"),
        },
        {
          label: "交办提炼设定",
          title: `从《${active.title}》提炼设定与伏笔`,
          prompt: [
            `请通读《${projectTitle}》章节《${active.title}》（projectId=${projectId}, documentId=${active.id}）：`,
            "1. 调用 `zhizhang_read_chapter` 阅读正文；",
            "2. 提取本章新增或变化的人物设定与伏笔，分别通过 `zhizhang_propose_setting` 和 `zhizhang_propose_foreshadow` 提交待确认提案。",
          ].join("\n"),
        },
      ];

      for (const item of actions) {
        grid.append(
          createButton({
            label: item.label,
            variant: item.primary ? "primary" : "secondary",
            size: "sm",
            onClick: () =>
              dispatchAgentHandoff({
                title: item.title,
                prompt: item.prompt,
                context: { projectId, documentId: active.id, product: active.product },
              }),
          }),
        );
      }
    } else {
      const actions: ReadonlyArray<{
        readonly label: string;
        readonly primary?: boolean;
        readonly title: string;
        readonly prompt: string;
      }> = [
        {
          label: "交办拟5标题",
          primary: true,
          title: `为《${active.title || "微头条"}》拟定标题矩阵`,
          prompt: [
            `请为头条作品《${projectTitle}》当前稿件（documentId=${active.id}）策划驱动角度与 5 组不同母题标题（严格 ≤34 字，微头条不设标题）：`,
            "1. 先调用 `zhizhang_read_article` 了解当前体裁与内容线；",
            "2. 拟定完成后调用 `zhizhang_plan_toutiao_article` 写入场景规划。",
          ].join("\n"),
        },
        {
          label: "交办写初稿",
          title: `撰写头条稿件《${active.title || "微头条"}》`,
          prompt: [
            `请根据《${projectTitle}》当前稿件规划（documentId=${active.id}）撰写正文，调用 \`zhizhang_submit_draft\` 提交（当前为${modeLabel}）。`,
          ].join("\n"),
        },
        {
          label: "交办自检打磨",
          title: `对照 84 分红线打磨《${active.title || "微头条"}》`,
          prompt: [
            `请调用 \`zhizhang_read_article\` 检查稿件（documentId=${active.id}），围绕 84 分质检标准优化薄弱段落，并用 \`zhizhang_patch_paragraphs\` 提交局部修订。`,
          ].join("\n"),
        },
      ];
      for (const item of actions) {
        grid.append(
          createButton({
            label: item.label,
            variant: item.primary ? "primary" : "secondary",
            size: "sm",
            onClick: () =>
              dispatchAgentHandoff({
                title: item.title,
                prompt: item.prompt,
                context: { projectId, documentId: active.id, product: active.product },
              }),
          }),
        );
      }
    }
    return grid;
  }

  function renderCompanionPanel(snapshot: WorkspaceSnapshot): void {
    companionContainer.replaceChildren();
    const active = snapshot.active;
    const { projectId } = host.getState();
    if (!active || !projectId) return;

    const currentMode: CollaborationMode = snapshot.collaborationMode === "co_create" ? "co_create" : "cautious";
    const promptEnabled = snapshot.agentPromptInjection !== false;

    const bodyNodes: HTMLElement[] = [];

    // 1. Per-book collaboration mode segmented switch
    const modeRow = el("div", { className: "agent-mode-row" });
    modeRow.append(el("span", { className: "field-label", text: "本书 Agent 写入权限" }));
    const seg = el("div", { className: "segmented" });
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Agent 协作模式");

    for (const [modeId, label] of [["cautious", "审慎模式"], ["co_create", "共创模式"]] as const) {
      const btn = createButton({
        label,
        variant: "ghost",
        size: "sm",
        active: currentMode === modeId,
        pressed: currentMode === modeId,
        dataset: { collabMode: modeId },
        onClick: () =>
          void host.perform(async () => {
            if (currentMode === modeId) return;
            await host.request("project.collaboration.set", {
              projectId,
              collaborationMode: modeId,
            });
            await host.load();
            host.notice(
              modeId === "co_create"
                ? "已切换为「共创模式」：Agent 可直写未定稿草稿并保留版本快照一键回滚"
                : "已切换为「审慎模式」：Agent 产出均落入候选区/提案箱等待作者审批",
            );
          }),
      });
      seg.append(btn);
    }
    modeRow.append(seg);
    bodyNodes.push(modeRow);

    bodyNodes.push(
      el("p", {
        className: "muted-copy agent-mode-desc",
        text:
          currentMode === "co_create"
            ? "未定稿章节允许 DsH Agent 直写草稿并自动留存快照；已定稿/已验收/锁定设定仍受硬规则保护。"
            : "所有 DsH Agent 草稿、精修与设定均落入候选区/提案箱，由你对比 Diff 后采纳。",
      }),
    );

    // 2. Primary Agent Handoff quick actions
    bodyNodes.push(buildQuickActions(snapshot));

    // 3. Pending proposal counter shortcut
    const pendingProposals = snapshot.pendingProposalCount ?? 0;
    if (pendingProposals > 0) {
      const inboxRow = el("div", { className: "agent-inbox-row" });
      inboxRow.append(
        el("span", { className: "setting-meta tabular", text: `待审批提案 ${pendingProposals} 条` }),
        createButton({
          label: "去审阅提案",
          variant: "secondary",
          size: "sm",
          onClick: () => host.switchWorkspaceView("worldbook"),
        }),
      );
      bodyNodes.push(inboxRow);
    }

    // 4. Progressive-disclosure system prompt controls & preview
    const promptDetails = document.createElement("details");
    promptDetails.className = "disclosure agent-prompt-drawer";
    const promptSummary = document.createElement("summary");
    promptSummary.textContent = promptPreview
      ? `渐进披露系统提示（约 ${promptPreview.tokenEstimate} tokens）`
      : "渐进披露系统提示（焦点与技法目录）";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "check";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = promptEnabled;
    toggleInput.onchange = () =>
      void host.perform(async () => {
        await host.request("project.collaboration.set", {
          projectId,
          agentPromptInjection: toggleInput.checked,
        });
        promptPreview = await host.request<CollaborationSystemPromptDto>("agent.system_prompt.preview", {
          projectId,
          documentId: active.id,
        });
        await host.load();
        host.notice(toggleInput.checked ? "已开启 DsH 系统提示词渐进披露注入" : "已关闭本书 DsH 系统提示词注入");
      });
    toggleLabel.append(toggleInput, document.createTextNode("向 DsH 对话注入当前焦点与技法目录"));

    const previewActions = el("div", { className: "actions" });
    previewActions.append(
      createButton({
        label: "预览注入内容",
        variant: "secondary",
        size: "sm",
        onClick: () =>
          void host.perform(async () => {
            promptPreview = await host.request<CollaborationSystemPromptDto>("agent.system_prompt.preview", {
              projectId,
              documentId: active.id,
            });
            renderCompanionPanel(lastSnapshot);
            const openDetails = companionContainer.querySelector<HTMLDetailsElement>(".agent-prompt-drawer");
            if (openDetails) openDetails.open = true;
          }),
      }),
    );

    promptDetails.append(promptSummary, toggleLabel, previewActions);
    if (promptPreview) {
      promptDetails.append(
        el("pre", {
          className: "server-body-preview agent-prompt-preview",
          text: promptPreview.enabled ? promptPreview.text : "（已关闭本书系统提示词注入）",
        }),
      );
    }
    bodyNodes.push(promptDetails);

    companionContainer.append(
      createCard({
        tag: "section",
        variant: "elevated",
        padding: "sm",
        eyebrow: "DsH AGENT 共创主引擎",
        title: "交办对话 Agent 协同创作",
        body: bodyNodes,
        className: "agent-companion-card",
      }),
    );
  }

  return {
    update(snapshot: WorkspaceSnapshot): void {
      lastSnapshot = snapshot;
      renderCompanionPanel(snapshot);
      renderWriteBanner(snapshot);
      renderHandoffStrip();
    },
    clearHandoff(): void {
      activeHandoff = null;
      renderHandoffStrip();
    },
    focusCompanionTab(): void {
      const elDrawer = byId<HTMLDetailsElement>("fallback-engine-drawer");
      if (elDrawer) elDrawer.open = false;
    },
  };
}
