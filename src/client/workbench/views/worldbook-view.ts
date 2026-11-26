import type {
  AiProposalDto,
  ForeshadowDto,
  LoreCategory,
  LoreConflictDto,
  LoreEntryDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  all: "全部",
  character: "人物",
  item: "物品",
  location: "地点",
  faction: "势力",
  world_rule: "世界规则",
  foreshadow: "伏笔设定",
  agreement: "全书约定",
};

const FORESHADOW_LABELS: Readonly<Record<string, string>> = {
  proposed: "提案中",
  planted: "已埋设",
  hinted: "推进提示中",
  resolved: "已回收",
  abandoned: "已废弃",
};

export function createWorldbookView(container: HTMLElement, host: WorkbenchShellHost) {
  let category: string = "all";
  let query = "";
  let entries: readonly LoreEntryDto[] = [];
  let loreCursor: string | null = null;
  let foreshadows: readonly ForeshadowDto[] = [];
  let conflicts: readonly LoreConflictDto[] = [];
  let proposals: readonly AiProposalDto[] = [];

  async function refresh(): Promise<void> {
    const { projectId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    if (!project || project.product !== "fanqie") {
      container.replaceChildren(el("p", "请选择番茄连载项目以管理动态设定库与伏笔追踪。", "muted-copy"));
      return;
    }
    const [loreRes, fsRes, conflictRes, propSettingRes, propFactSyncRes] = await Promise.all([
      host.request<{ entries: readonly LoreEntryDto[]; cursor?: string | null }>("lore.list", {
        projectId,
        ...(category !== "all" ? { category: category as LoreCategory } : {}),
        ...(query.trim() ? { entityName: query.trim() } : {}),
      }),
      host.request<readonly ForeshadowDto[]>("foreshadow.list", { projectId }),
      host.request<readonly LoreConflictDto[]>("lore.conflicts", { projectId }),
      host.request<readonly AiProposalDto[]>("proposal.list", { projectId, kind: "setting", status: "pending" }),
      host.request<readonly AiProposalDto[]>("proposal.list", { projectId, kind: "fact_sync", status: "pending" }),
    ]);
    entries = loreRes.entries;
    loreCursor = loreRes.cursor ?? null;
    foreshadows = fsRes;
    conflicts = conflictRes;
    proposals = [...propFactSyncRes, ...propSettingRes].sort((a, b) => b.createdAt - a.createdAt);
    paint();
  }

  async function loadMoreLore(): Promise<void> {
    const { projectId } = host.getState();
    if (!projectId || !loreCursor) return;
    const more = await host.request<{ entries: readonly LoreEntryDto[]; cursor?: string | null }>("lore.list", {
      projectId,
      cursor: loreCursor,
      ...(category !== "all" ? { category: category as LoreCategory } : {}),
      ...(query.trim() ? { entityName: query.trim() } : {}),
    });
    entries = [...entries, ...more.entries];
    loreCursor = more.cursor ?? null;
    paint();
  }

  function paint(): void {
    const { projectId, documentId } = host.getState();
    container.replaceChildren();

    const header = el("header", "", "view-header");
    const left = el("div");
    left.append(
      el("p", "结构化设定现行态 · 伏笔追踪 · 时序冲突预警", "eyebrow"),
      el("h1", "动态设定库"),
    );

    const addFsBtn = createButton({
      label: "+ 登记新伏笔",
      variant: "primary",
      onClick: () =>
        void host.perform(async () => {
          const title = await host.modal.prompt({
            title: "登记长篇伏笔",
            message: "输入伏笔名称，例如：银色怀表背面的刻字",
            label: "伏笔标题",
            confirmLabel: "保存伏笔",
          });
          if (!title?.trim()) return;
          await host.request("foreshadow.create", {
            projectId,
            title: title.trim(),
            plantedChapterId: documentId || undefined,
            status: "planted",
          });
          await refresh();
        }),
    });
    header.append(left, addFsBtn);
    container.append(header);

    // 1. Conflict diagnostics banner
    if (conflicts.length > 0) {
      const box = el("section", "", "conflict-panel");
      box.append(el("p", `检测到 ${conflicts.length} 项设定/伏笔连续性预警`, "conflict-title"));
      const ul = el("ul", "", "modal-list");
      for (const c of conflicts) {
        ul.append(el("li", `[${c.severity === "error" ? "严重" : "提醒"}] ${c.message}`));
      }
      box.append(ul);
      container.append(box);
    }

    // 2. Pending AI Setting / Fact-Sync Proposals
    if (proposals.length > 0) {
      const propRows: HTMLElement[] = [];
      for (const prop of proposals) {
        const row = el("div", "", "proposal-row");
        const isFactSync = prop.kind === "fact_sync";
        const newFacts = Array.isArray(prop.payload.newFacts) ? (prop.payload.newFacts as readonly Record<string, unknown>[]) : [];
        const settingsList = Array.isArray(prop.payload.settings) ? prop.payload.settings : [];
        const knownUpdates = Array.isArray(prop.payload.knownFromUpdates) ? prop.payload.knownFromUpdates : [];
        const fsList = isFactSync
          ? (Array.isArray(prop.payload.foreshadowUpdates) ? prop.payload.foreshadowUpdates : [])
          : (Array.isArray(prop.payload.foreshadows) ? prop.payload.foreshadows : []);
        const summaryLine = isFactSync
          ? `记忆同步 · ${prop.sourceRef || "章节增量"} · 含 ${newFacts.length} 条新事实、${knownUpdates.length} 条知情更新、${fsList.length} 条伏笔${typeof prop.payload.summaryDraft === "string" && prop.payload.summaryDraft ? " + 摘要草案" : ""}`
          : `来源：${prop.sourceRef || "章节提取"} · 含 ${settingsList.length} 条设定、${fsList.length} 条伏笔`;
        row.append(el("p", summaryLine, "setting-title"));

        const checkboxes: HTMLInputElement[] = [];
        if (isFactSync && newFacts.length > 0) {
          const checklist = el("div", "", "proposal-checklist");
          newFacts.forEach((item, index) => {
            const fid = typeof item.factId === "string" ? item.factId : "";
            const label = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.value = fid;
            cb.dataset.index = String(index);
            checkboxes.push(cb);
            const name = typeof item.entityName === "string" && item.entityName ? item.entityName : fid || `第 ${index + 1} 条`;
            label.append(cb, ` ${name}：${typeof item.note === "string" ? item.note : ""}`);
            checklist.append(label);
          });
          row.append(checklist);
        }
        const retirements: HTMLInputElement[] = [];
        const retiredFacts = isFactSync && Array.isArray(prop.payload.retiredFacts)
          ? prop.payload.retiredFacts as Record<string, unknown>[]
          : [];
        if (retiredFacts.length) {
          const checklist = el("div", "", "proposal-checklist");
          retiredFacts.forEach((item, index) => {
            if (!item || typeof item !== "object") return;
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = String(index);
            retirements.push(checkbox);
            label.append(checkbox, ` 结束设定 ${String(item.factId)} · 第 ${String(item.point ?? 1)} 段 · ${String(item.reason ?? "")}`);
            checklist.append(label);
          });
          row.append(checklist);
        }
        row.append(el("pre", JSON.stringify(prop.payload, null, 2), "server-body-preview"));

        const actions = el("div", "", "actions");
        actions.append(
          createButton({
            label: "确认入库",
            variant: "primary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("proposal.decide", {
                  proposalId: prop.id,
                  accept: true,
                  ...(retirements.length ? { selectedRetiredFactIndices: retirements.filter((checkbox) => checkbox.checked).map((checkbox) => Number(checkbox.value)) } : {}),
                  ...(isFactSync && checkboxes.length > 0
                    ? {
                      selectedNewFactIndices: checkboxes
                        .filter((cb) => cb.checked)
                        .map((cb) => Number(cb.dataset.index)),
                    }
                    : {}),
                });
                host.notice("设定提案已确认入库");
                await refresh();
                await host.load();
              }),
          }),
          createButton({
            label: "拒绝提案",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("proposal.decide", { proposalId: prop.id, accept: false });
                await refresh();
              }),
          }),
        );
        row.append(actions);
        propRows.push(row);
      }
      container.append(
        createCard({
          tag: "section",
          variant: "elevated",
          padding: "md",
          title: `待确认 AI 设定与记忆同步提案（${proposals.length}）`,
          body: propRows,
        }),
      );
    }

    // 3. Category filter bar
    const filterBar = el("div", "", "filter-toolbar");
    const seg = el("div", "", "segmented");
    for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
      seg.append(
        createButton({
          label,
          variant: "ghost",
          size: "sm",
          active: key === category,
          pressed: key === category,
          onClick: () => {
            category = key;
            void host.perform(refresh);
          },
        }),
      );
    }
    const searchField = createInput({
      kind: "search",
      ariaLabel: "按实体名筛选",
      placeholder: "按实体名筛选…",
      value: query,
      onChange: (val) => {
        query = val;
        void host.perform(refresh);
      },
    });
    filterBar.append(seg, searchField.root);
    container.append(filterBar);

    // 4. Current materialized lore grid
    const loreBody: HTMLElement[] = [];
    if (entries.length === 0) {
      loreBody.push(el("p", "暂无匹配设定；可在右侧「设定」标签页提交提案并确认。", "muted-copy"));
    } else {
      for (const entry of entries) {
        const eyebrow = `[${CATEGORY_LABELS[entry.category] ?? entry.category}]${entry.locked ? " · [已锁定]" : ""}`;
        const title = `${entry.entityName ? `${entry.entityName} · ` : ""}${entry.factId}`;
        loreBody.push(
          createCard({
            tag: "article",
            variant: "subtle",
            padding: "sm",
            eyebrow,
            title,
            body: [
              el("p", entry.fact.note),
              el("p", `来源 ${entry.fact.source} · 生效章 ${entry.fact.effectiveFrom.chapterId} 第 ${entry.fact.effectiveFrom.point} 段`, "setting-meta"),
            ],
            className: "setting-item",
          }),
        );
      }
      if (loreCursor) {
        loreBody.push(
          createButton({
            label: "加载更多设定",
            variant: "secondary",
            size: "sm",
            onClick: () => void host.perform(loadMoreLore),
          }),
        );
      }
    }
    container.append(
      createCard({
        tag: "section",
        variant: "default",
        padding: "md",
        title: `当前生效设定档案（${entries.length}）`,
        body: loreBody,
      }),
    );

    // 5. Foreshadows
    const fsBody: HTMLElement[] = [];
    if (foreshadows.length === 0) {
      fsBody.push(el("p", "尚未登记伏笔。", "muted-copy"));
    } else {
      for (const fs of foreshadows) {
        const canResolve = fs.status === "planted" || fs.status === "hinted";
        const footer = canResolve
          ? createButton({
            label: "标记已在当前章回收",
            variant: "primary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("foreshadow.patch", {
                  projectId,
                  id: fs.id,
                  status: "resolved",
                  resolvedChapterId: documentId || undefined,
                });
                await refresh();
              }),
          })
          : undefined;
        fsBody.push(
          createCard({
            tag: "article",
            variant: "subtle",
            padding: "sm",
            eyebrow: FORESHADOW_LABELS[fs.status] ?? fs.status,
            title: fs.title,
            body: el("p", fs.note || "暂无备注", "setting-meta"),
            ...(footer ? { footer } : {}),
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
        title: `伏笔账本（${foreshadows.length}）`,
        body: fsBody,
      }),
    );
  }

  return { refresh };
}
