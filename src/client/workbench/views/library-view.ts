import type {
  AiProposalDto,
  DeconstructionDto,
  LibraryMountDto,
  SkillImportPreviewDto,
  TechniqueCardDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";

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
      const btn = el("button", label, scopeFilter === id ? "active" : undefined);
      btn.type = "button";
      btn.onclick = () => {
        scopeFilter = id;
        void host.perform(refresh);
      };
      seg.append(btn);
    }
    toolbar.append(seg);
    if (kind === "techniques") {
      const importSkillBtn = el("button", "导入 SKILL.md");
      importSkillBtn.type = "button";
      importSkillBtn.onclick = () =>
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
        });
      toolbar.append(importSkillBtn);
    }
    header.append(left, toolbar);
    container.append(header);

    // Pending AI proposals
    if (proposals.length > 0) {
      const propBox = el("section", "", "panel-card");
      propBox.append(el("h2", `待作者确认的 AI ${kind === "deconstruct" ? "拆书" : "技法"}提案（${proposals.length}）`));
      for (const prop of proposals) {
        const row = el("div", "", "proposal-row");
        row.append(el("pre", JSON.stringify(prop.payload, null, 2), "server-body-preview"));
        const actions = el("div", "", "actions");
        const approveBtn = el("button", "确认入库", "primary");
        approveBtn.type = "button";
        approveBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: true });
            host.notice("提案已入库生效");
            await refresh();
          });
        const rejectBtn = el("button", "拒绝");
        rejectBtn.type = "button";
        rejectBtn.onclick = () =>
          void host.perform(async () => {
            await host.request("proposal.decide", { proposalId: prop.id, accept: false });
            await refresh();
          });
        actions.append(approveBtn, rejectBtn);
        row.append(actions);
        propBox.append(row);
      }
      container.append(propBox);
    }

    // Create / Save Form
    const formCard = el("section", "", "panel-card");
    const form = document.createElement("form");
    form.className = "stack-form";

    if (kind === "deconstruct") {
      formCard.append(el("h2", "新增拆书样本"));
      form.innerHTML = `
        <label>样本标题<input name="title" required placeholder="例如：黄金三章开篇退婚冲突"></label>
        <label>出处书名<input name="sourceBook" placeholder="例：《某某传》"></label>
        <label>题材 / 节奏（快爽/稳推/慢燃）<input name="pacing" placeholder="快爽"></label>
        <label>标签（逗号分隔）<input name="tags" placeholder="退婚, 反转, 黄金三章"></label>
        <label>样本原文片段<textarea name="excerpt" rows="4" required></textarea></label>
        <label>开篇钩子分析<textarea name="hookAnalysis" rows="2"></textarea></label>
        <label>冲突节拍拆解<textarea name="conflictBeats" rows="2"></textarea></label>
        <label>爽点与情绪节奏<textarea name="payoffRhythm" rows="2"></textarea></label>
        <label>文笔与章法批注<textarea name="proseNotes" rows="2"></textarea></label>
        <label class="check"><input name="projectOnly" type="checkbox">仅存为当前项目专属（不进全局库）</label>
        <button type="submit" class="primary">保存到拆书库</button>
      `;
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
    } else {
      formCard.append(el("h2", "新增写作技法卡片"));
      form.innerHTML = `
        <label>技法卡名称<input name="title" required placeholder="例如：三段式信息差反转"></label>
        <label>分类<select name="category">
          <option value="opening">开篇</option><option value="hook">钩子</option>
          <option value="conflict">冲突</option><option value="dialogue">对话</option>
          <option value="foreshadow">伏笔</option><option value="pacing">节奏</option>
          <option value="cliffhanger">章末断章</option><option value="narrative" selected>叙事通用</option>
        </select></label>
        <label>适用节奏（快爽/稳推/慢燃，可留空）<input name="pacing" placeholder="快爽"></label>
        <label>场景标签（逗号分隔）<input name="sceneTags" placeholder="打脸, 揭秘, 高潮"></label>
        <label>触发条件<input name="triggerWhen" placeholder="主角握有对手未知的底牌时"></label>
        <label>执行步骤<textarea name="executionSteps" rows="3" required placeholder="1. 先放对手嚣张立flag；2. 给配角反应镜头；3. 一句亮底牌收尾"></textarea></label>
        <label>关键约束<textarea name="constraints" rows="2"></textarea></label>
        <label>禁忌反例<textarea name="antiPatterns" rows="2"></textarea></label>
        <label class="check"><input name="projectOnly" type="checkbox">仅存为当前项目专属（不进全局库）</label>
        <button type="submit" class="primary">保存技法卡片</button>
      `;
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
          host.notice("技法卡片已保存");
          await refresh();
        });
      };
    }
    formCard.append(form);
    container.append(formCard);

    // List Section
    const listCard = el("section", "", "panel-card");
    const items = kind === "deconstruct" ? deconstructions : techniques;
    listCard.append(el("h2", `已入库条目（${items.length}）`));
    if (items.length === 0) {
      listCard.append(el("p", "暂无条目，请先新增或通过本地导入包导入。", "muted-copy"));
    } else {
      for (const item of items) {
        const card = el("article", "", "setting-item");
        const scopeBadge = item.overrideOfId ? "本书覆写全局" : item.scope === "global" ? "全局共享" : "本书专属";
        const skillTag = kind === "techniques" && (item as TechniqueCardDto).assetKind === "skill" ? " · [Skill]" : "";
        card.append(el("p", `${item.title} · [${scopeBadge}]${skillTag}${item.pacing ? ` · ${item.pacing}` : ""}`, "setting-title"));
        if (kind === "deconstruct") {
          const dec = item as DeconstructionDto;
          card.append(
            el("p", [dec.sourceBook && `出处《${dec.sourceBook}》`, dec.hookAnalysis, dec.conflictBeats].filter(Boolean).join(" · "), "setting-meta"),
            el("p", dec.excerpt.slice(0, 180) + (dec.excerpt.length > 180 ? "…" : "")),
          );
        } else {
          const tech = item as TechniqueCardDto;
          const stageNote = tech.stageBindings?.length ? `阶段: ${tech.stageBindings.join("/")}` : "";
          const refNote = tech.references?.length ? `参考附件 ${tech.references.length} 份` : "";
          card.append(
            el("p", [tech.category, stageNote, refNote, tech.triggerWhen, tech.sceneTags.join("、")].filter(Boolean).join(" · "), "setting-meta"),
            el("p", tech.executionSteps),
          );
        }

        const actions = el("div", "", "actions");
        if (projectId) {
          const itemKind = kind === "deconstruct" ? "deconstruction" : "technique";
          const projMounted = mounts.some(
            (m) => m.itemKind === itemKind && m.itemId === item.id && m.targetType === "project",
          );
          const mountProjBtn = el("button", projMounted ? "取消全书挂载" : "挂载到全书");
          mountProjBtn.type = "button";
          mountProjBtn.onclick = () =>
            void host.perform(async () => {
              await host.request(projMounted ? "library.unmount" : "library.mount", {
                projectId,
                targetType: "project",
                targetId: projectId,
                itemKind,
                itemId: item.id,
              });
              await refresh();
            });
          actions.append(mountProjBtn);

          if (documentId && active?.product === "fanqie") {
            const chMounted = mounts.some(
              (m) => m.itemKind === itemKind && m.itemId === item.id && m.targetType === "chapter" && m.targetId === documentId,
            );
            const mountChBtn = el("button", chMounted ? "取消本章挂载" : "置顶挂载到当前章", chMounted ? undefined : "primary");
            mountChBtn.type = "button";
            mountChBtn.onclick = () =>
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
              });
            actions.append(mountChBtn);
          }

          if (item.scope === "global") {
            const overrideBtn = el("button", "本书覆写此卡");
            overrideBtn.type = "button";
            overrideBtn.onclick = () =>
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
              });
            actions.append(overrideBtn);
          }
        }

        const delBtn = el("button", "删除", "danger");
        delBtn.type = "button";
        delBtn.onclick = () =>
          void host.perform(async () => {
            const confirmed = await host.modal.confirm({
              title: "删除库条目",
              message: `确认删除「${item.title}」？`,
              confirmLabel: "确认删除",
              destructive: true,
            });
            if (!confirmed) return;
            await host.request(kind === "deconstruct" ? "deconstruct.delete" : "technique.delete", { id: item.id });
            await refresh();
          });
        actions.append(delBtn);
        card.append(actions);
        listCard.append(card);
      }
    }
    container.append(listCard);
  }

  return { refresh };
}
