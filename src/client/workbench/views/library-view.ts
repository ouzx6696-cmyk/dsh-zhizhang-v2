import type {
  AiProposalDto,
  DeconstructionDto,
  LibraryMountDto,
  SkillImportPreviewDto,
  TechniqueCardDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

const TECHNIQUE_CATEGORIES = [
  { value: "opening", label: "开篇" },
  { value: "hook", label: "钩子" },
  { value: "conflict", label: "冲突" },
  { value: "dialogue", label: "对话" },
  { value: "foreshadow", label: "伏笔" },
  { value: "pacing", label: "节奏" },
  { value: "cliffhanger", label: "章末断章" },
  { value: "narrative", label: "叙事通用" },
] as const;

function createCheckboxField(name: string, labelText: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "check";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = name;
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(checkbox, text);
  return label;
}

export function createLibraryView(
  container: HTMLElement,
  host: WorkbenchShellHost,
  kind: "deconstruct" | "techniques",
) {
  let scopeFilter: "all" | "global" | "project" = "all";
  let deconstructions: readonly DeconstructionDto[] = [];
  let techniques: readonly TechniqueCardDto[] = [];
  let mounts: readonly LibraryMountDto[] = [];
  let proposals: readonly AiProposalDto[] = [];

  async function refresh(): Promise<void> {
    const { projectId } = host.getState();
    const proposalKind = kind === "deconstruct" ? "deconstruct" : "technique";
    const [items, projectMounts, pendingProps] = await Promise.all([
      kind === "deconstruct"
        ? host.request<readonly DeconstructionDto[]>("deconstruct.list", {
            ...(projectId ? { projectId } : {}),
            scope: scopeFilter,
          })
        : host.request<readonly TechniqueCardDto[]>("technique.list", {
            ...(projectId ? { projectId } : {}),
            scope: scopeFilter,
          }),
      projectId ? host.request<readonly LibraryMountDto[]>("library.mounts", { projectId }) : Promise.resolve([]),
      host.request<readonly AiProposalDto[]>("proposal.list", {
        ...(projectId ? { projectId } : {}),
        kind: proposalKind,
        status: "pending",
      }),
    ]);
    if (kind === "deconstruct") deconstructions = items as readonly DeconstructionDto[];
    else techniques = items as readonly TechniqueCardDto[];
    mounts = projectMounts;
    proposals = pendingProps;
    paint();
  }

  function paint(): void {
    const { projectId, documentId, snapshot } = host.getState();
    const active = snapshot.active;
    container.replaceChildren();

    const header = el("header", "", "view-header");
    const left = el("div");
    left.append(
      el("p", "全局共享资产库 + 本书覆盖挂载", "eyebrow"),
      el("h1", kind === "deconstruct" ? "长篇拆书库" : "写作技法卡片库"),
    );

    const toolbar = el("div", "", "actions");
    const seg = el("div", "", "segmented");
    for (const [id, label] of [["all", "全部有效"], ["global", "全局库"], ["project", "本书专属/覆写"]] as const) {
      seg.append(
        createButton({
          label,
          variant: "ghost",
          size: "sm",
          active: scopeFilter === id,
          pressed: scopeFilter === id,
          onClick: () => {
            scopeFilter = id;
            void host.perform(refresh);
          },
        }),
      );
    }
    toolbar.append(seg);
    if (kind === "techniques") {
      toolbar.append(
        createButton({
          label: "导入 SKILL.md",
          variant: "secondary",
          size: "sm",
          onClick: () =>
            void host.perform(async () => {
              const skillMd = await host.modal.prompt({
                title: "导入标准 SKILL.md（纯提示词沙箱）",
                message: "请粘贴 SKILL.md 全文。导入前将自动校验大小（≤ 128 KiB）、剥离脚本/Hook/工具声明并展示预览。",
                label: "SKILL.md 原文",
                placeholder: "---\nname: 去AI味写法\nstage_bindings: [write, deslop]\n---\n\n...",
                confirmLabel: "沙箱解析预览",
              });
              if (!skillMd?.trim()) return;
              const targetScope = scopeFilter === "project" && projectId ? "project" : "global";
              const preview = await host.request<SkillImportPreviewDto>("skill.import", {
                skillMd,
                preview: true,
                scope: targetScope,
                ...(targetScope === "project" && projectId ? { projectId } : {}),
              });
              const details: string[] = [
                `标题：${preview.title}`,
                `适用阶段：${preview.stageBindings.join(" / ") || "write"}`,
                preview.strippedCapabilities.length > 0
                  ? `已自动剥离危险/非提示词字段：${preview.strippedCapabilities.join("、")}`
                  : "未检出需剥离的脚本/Hook/工具字段",
                ...preview.warnings.map((w) => `提示：${w}`),
                `正文字数摘要：${preview.rawPreview.slice(0, 140).replace(/\s+/gu, " ")}`,
              ];
              const confirmed = await host.modal.confirm({
                title: "确认导入标准 SKILL.md（沙箱预览）",
                message: `将以「${targetScope === "global" ? "全局共享" : "本书专属"}」纯提示词 Skill 入库，确认继续？`,
                details,
                confirmLabel: "确认入库",
              });
              if (!confirmed) return;
              await host.request("skill.import", {
                skillMd,
                preview: false,
                scope: targetScope,
                ...(targetScope === "project" && projectId ? { projectId } : {}),
              });
              host.notice(`Skill「${preview.title}」已通过沙箱导入`);
              await refresh();
            }),
        }),
      );
    }
    header.append(left, toolbar);
    container.append(header);

    // Pending AI proposals
    if (proposals.length > 0) {
      const proposalRows: HTMLElement[] = [];
      for (const prop of proposals) {
        const actions = el("div", "", "actions");
        actions.append(
          createButton({
            label: "确认入库",
            variant: "primary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("proposal.decide", { proposalId: prop.id, accept: true });
                host.notice("提案已入库生效");
                await refresh();
              }),
          }),
          createButton({
            label: "拒绝",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("proposal.decide", { proposalId: prop.id, accept: false });
                await refresh();
              }),
          }),
        );
        const row = el("div", "", "proposal-row");
        row.append(el("pre", JSON.stringify(prop.payload, null, 2), "server-body-preview"), actions);
        proposalRows.push(row);
      }
      container.append(
        createCard({
          tag: "section",
          variant: "elevated",
          padding: "md",
          title: `待作者确认的 AI ${kind === "deconstruct" ? "拆书" : "技法"}提案（${proposals.length}）`,
          body: proposalRows,
        }),
      );
    }

    // Create / Save Form (safe DOM construction via unified Input + Button + Card)
    const form = document.createElement("form");
    form.className = "stack-form";

    if (kind === "deconstruct") {
      const titleField = createInput({
        label: "样本标题",
        name: "title",
        required: true,
        placeholder: "例如：黄金三章开篇退婚冲突",
      });
      const sourceBookField = createInput({
        label: "出处书名",
        name: "sourceBook",
        placeholder: "例：《某某传》",
      });
      const pacingField = createInput({
        label: "题材 / 节奏（快爽/稳推/慢燃）",
        name: "pacing",
        placeholder: "快爽",
      });
      const tagsField = createInput({
        label: "标签（逗号分隔）",
        name: "tags",
        placeholder: "退婚, 反转, 黄金三章",
      });
      const excerptField = createInput({
        kind: "textarea",
        label: "样本原文片段",
        name: "excerpt",
        rows: 4,
        required: true,
      });
      const hookField = createInput({
        kind: "textarea",
        label: "开篇钩子分析",
        name: "hookAnalysis",
        rows: 2,
      });
      const conflictField = createInput({
        kind: "textarea",
        label: "冲突节拍拆解",
        name: "conflictBeats",
        rows: 2,
      });
      const payoffField = createInput({
        kind: "textarea",
        label: "爽点与情绪节奏",
        name: "payoffRhythm",
        rows: 2,
      });
      const proseField = createInput({
        kind: "textarea",
        label: "文笔与章法批注",
        name: "proseNotes",
        rows: 2,
      });
      const projectOnlyCheck = createCheckboxField("projectOnly", "仅存为当前项目专属（不进全局库）");
      const submitBtn = createButton({
        label: "保存到拆书库",
        variant: "primary",
        type: "submit",
      });

      form.append(
        titleField.root,
        sourceBookField.root,
        pacingField.root,
        tagsField.root,
        excerptField.root,
        hookField.root,
        conflictField.root,
        payoffField.root,
        proseField.root,
        projectOnlyCheck,
        submitBtn,
      );

      form.onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const projectOnly = fd.get("projectOnly") === "on" && Boolean(projectId);
        void host.perform(async () => {
          await host.request("deconstruct.save", {
            scope: projectOnly ? "project" : "global",
            ...(projectOnly ? { projectId } : {}),
            title: String(fd.get("title") ?? ""),
            sourceBook: String(fd.get("sourceBook") ?? ""),
            pacing: String(fd.get("pacing") ?? ""),
            tags: String(fd.get("tags") ?? ""),
            excerpt: String(fd.get("excerpt") ?? ""),
            hookAnalysis: String(fd.get("hookAnalysis") ?? ""),
            conflictBeats: String(fd.get("conflictBeats") ?? ""),
            payoffRhythm: String(fd.get("payoffRhythm") ?? ""),
            proseNotes: String(fd.get("proseNotes") ?? ""),
          });
          form.reset();
          host.notice("拆书样本已保存");
          await refresh();
        });
      };

      container.append(
        createCard({
          tag: "section",
          variant: "default",
          padding: "md",
          title: "新增拆书样本",
          body: form,
        }),
      );
    } else {
      const titleField = createInput({
        label: "技法卡名称",
        name: "title",
        required: true,
        placeholder: "例如：三段式信息差反转",
      });
      const categoryField = createInput({
        kind: "select",
        label: "分类",
        name: "category",
        value: "narrative",
        options: TECHNIQUE_CATEGORIES,
      });
      const pacingField = createInput({
        label: "适用节奏（快爽/稳推/慢燃，可留空）",
        name: "pacing",
        placeholder: "快爽",
      });
      const sceneTagsField = createInput({
        label: "场景标签（逗号分隔）",
        name: "sceneTags",
        placeholder: "打脸, 揭秘, 高潮",
      });
      const triggerField = createInput({
        label: "触发条件",
        name: "triggerWhen",
        placeholder: "主角握有对手未知的底牌时",
      });
      const stepsField = createInput({
        kind: "textarea",
        label: "执行步骤",
        name: "executionSteps",
        rows: 3,
        required: true,
        placeholder: "1. 先放对手嚣张立flag；2. 给配角反应镜头；3. 一句亮底牌收尾",
      });
      const constraintsField = createInput({
        kind: "textarea",
        label: "关键约束",
        name: "constraints",
        rows: 2,
      });
      const antiPatternsField = createInput({
        kind: "textarea",
        label: "禁忌反例",
        name: "antiPatterns",
        rows: 2,
      });
      const projectOnlyCheck = createCheckboxField("projectOnly", "仅存为当前项目专属（不进全局库）");
      const submitBtn = createButton({
        label: "保存技法卡片",
        variant: "primary",
        type: "submit",
      });

      form.append(
        titleField.root,
        categoryField.root,
        pacingField.root,
        sceneTagsField.root,
        triggerField.root,
        stepsField.root,
        constraintsField.root,
        antiPatternsField.root,
        projectOnlyCheck,
        submitBtn,
      );

      form.onsubmit = (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const projectOnly = fd.get("projectOnly") === "on" && Boolean(projectId);
        void host.perform(async () => {
          await host.request("technique.save", {
            scope: projectOnly ? "project" : "global",
            ...(projectOnly ? { projectId } : {}),
            title: String(fd.get("title") ?? ""),
            category: String(fd.get("category") ?? "narrative"),
            pacing: String(fd.get("pacing") ?? ""),
            sceneTags: String(fd.get("sceneTags") ?? ""),
            triggerWhen: String(fd.get("triggerWhen") ?? ""),
            executionSteps: String(fd.get("executionSteps") ?? ""),
            constraints: String(fd.get("constraints") ?? ""),
            antiPatterns: String(fd.get("antiPatterns") ?? ""),
          });
          form.reset();
          categoryField.setValue("narrative");
          host.notice("技法卡片已保存");
          await refresh();
        });
      };

      container.append(
        createCard({
          tag: "section",
          variant: "default",
          padding: "md",
          title: "新增写作技法卡片",
          body: form,
        }),
      );
    }

    // List Section
    const items = kind === "deconstruct" ? deconstructions : techniques;
    const listBody: HTMLElement[] = [];
    if (items.length === 0) {
      listBody.push(el("p", "暂无条目，请先新增或通过本地导入包导入。", "muted-copy"));
    } else {
      for (const item of items) {
        const scopeBadge = item.overrideOfId ? "本书覆写全局" : item.scope === "global" ? "全局共享" : "本书专属";
        const skillTag = kind === "techniques" && (item as TechniqueCardDto).assetKind === "skill" ? " · [Skill]" : "";
        const eyebrow = `[${scopeBadge}]${skillTag}${item.pacing ? ` · ${item.pacing}` : ""}`;
        const itemBody: HTMLElement[] = [];

        if (kind === "deconstruct") {
          const dec = item as DeconstructionDto;
          const metaLine = [dec.sourceBook && `出处《${dec.sourceBook}》`, dec.hookAnalysis, dec.conflictBeats]
            .filter(Boolean)
            .join(" · ");
          if (metaLine) itemBody.push(el("p", metaLine, "setting-meta"));
          itemBody.push(el("p", dec.excerpt.slice(0, 180) + (dec.excerpt.length > 180 ? "…" : "")));
        } else {
          const tech = item as TechniqueCardDto;
          const stageNote = tech.stageBindings?.length ? `阶段: ${tech.stageBindings.join("/")}` : "";
          const refNote = tech.references?.length ? `参考附件 ${tech.references.length} 份` : "";
          const metaLine = [tech.category, stageNote, refNote, tech.triggerWhen, tech.sceneTags.join("、")]
            .filter(Boolean)
            .join(" · ");
          if (metaLine) itemBody.push(el("p", metaLine, "setting-meta"));
          itemBody.push(el("p", tech.executionSteps));
        }

        const actions = el("div", "", "actions");
        if (projectId) {
          const itemKind = kind === "deconstruct" ? "deconstruction" : "technique";
          const projMounted = mounts.some(
            (m) => m.itemKind === itemKind && m.itemId === item.id && m.targetType === "project",
          );
          actions.append(
            createButton({
              label: projMounted ? "取消全书挂载" : "挂载到全书",
              variant: "secondary",
              size: "sm",
              onClick: () =>
                void host.perform(async () => {
                  await host.request(projMounted ? "library.unmount" : "library.mount", {
                    projectId,
                    targetType: "project",
                    targetId: projectId,
                    itemKind,
                    itemId: item.id,
                  });
                  await refresh();
                }),
            }),
          );

          if (documentId && active?.product === "fanqie") {
            const chMounted = mounts.some(
              (m) => m.itemKind === itemKind && m.itemId === item.id && m.targetType === "chapter" && m.targetId === documentId,
            );
            actions.append(
              createButton({
                label: chMounted ? "取消本章挂载" : "置顶挂载到当前章",
                variant: chMounted ? "secondary" : "primary",
                size: "sm",
                onClick: () =>
                  void host.perform(async () => {
                    await host.request(chMounted ? "library.unmount" : "library.mount", {
                      projectId,
                      targetType: "chapter",
                      targetId: documentId,
                      itemKind,
                      itemId: item.id,
                      mode: "pin",
                    });
                    await refresh();
                  }),
              }),
            );
          }

          if (item.scope === "global") {
            actions.append(
              createButton({
                label: "本书覆写此卡",
                variant: "secondary",
                size: "sm",
                onClick: () =>
                  void host.perform(async () => {
                    if (kind === "deconstruct") {
                      const dec = item as DeconstructionDto;
                      await host.request("deconstruct.save", {
                        scope: "project",
                        projectId,
                        overrideOfId: dec.id,
                        title: `${dec.title}（本书微调）`,
                        excerpt: dec.excerpt,
                        hookAnalysis: dec.hookAnalysis,
                        conflictBeats: dec.conflictBeats,
                        payoffRhythm: dec.payoffRhythm,
                        proseNotes: dec.proseNotes,
                      });
                    } else {
                      const tech = item as TechniqueCardDto;
                      await host.request("technique.save", {
                        scope: "project",
                        projectId,
                        overrideOfId: tech.id,
                        title: `${tech.title}（本书微调）`,
                        category: tech.category,
                        pacing: tech.pacing,
                        sceneTags: tech.sceneTags,
                        triggerWhen: tech.triggerWhen,
                        executionSteps: tech.executionSteps,
                        constraints: tech.constraints,
                        antiPatterns: tech.antiPatterns,
                        ...(tech.assetKind ? { assetKind: tech.assetKind } : {}),
                        ...(tech.stageBindings ? { stageBindings: tech.stageBindings } : {}),
                        ...(tech.references ? { references: tech.references } : {}),
                      });
                    }
                    host.notice("已创建本书专属覆写版本，不影响全局原卡");
                    await refresh();
                  }),
              }),
            );
          }
        }

        actions.append(
          createButton({
            label: "删除",
            variant: "danger",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                const confirmed = await host.modal.confirm({
                  title: "删除库条目",
                  message: `确认删除「${item.title}」？`,
                  confirmLabel: "确认删除",
                  destructive: true,
                });
                if (!confirmed) return;
                const { projectId: activeProjectId } = host.getState();
                await host.request(kind === "deconstruct" ? "deconstruct.delete" : "technique.delete", {
                  id: item.id,
                  scope: item.scope,
                  ...(activeProjectId ? { projectId: activeProjectId } : {}),
                });
                await refresh();
              }),
          }),
        );

        listBody.push(
          createCard({
            tag: "article",
            variant: "subtle",
            padding: "sm",
            eyebrow,
            title: item.title,
            body: itemBody,
            footer: actions,
            className: "setting-item",
          }),
        );
      }
    }

    container.append(
      createCard({
        tag: "section",
        variant: "default",
        padding: "md",
        title: `已入库条目（${items.length}）`,
        body: listBody,
      }),
    );
  }

  return { refresh };
}
