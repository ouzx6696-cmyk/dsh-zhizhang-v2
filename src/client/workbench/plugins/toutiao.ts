import type { CandidateQaReport, WorkspaceSnapshot } from "../../../contracts/workspace-dto.ts";
import { countUnicodeCodePoints } from "../diff.ts";
import { byId } from "../dom.ts";
import type { ProductLineUiModule, ProductLineUiSession, WorkbenchShellHost } from "./types.ts";

const TITLE_MAX = 34;

function syncTitleCount(field: HTMLInputElement, output: HTMLOutputElement, titled: boolean): void {
  const length = countUnicodeCodePoints(field.value);
  output.textContent = titled ? `${length} / ${TITLE_MAX} 字符` : "";
  output.classList.toggle("is-over-limit", titled && length > TITLE_MAX);
  field.setCustomValidity(titled && length > TITLE_MAX ? `标题最多 ${TITLE_MAX} 个字符` : "");
}

export const toutiaoUiModule: ProductLineUiModule = {
  id: "toutiao",
  displayName: "头条",
  lockedStates: ["已验收", "已交稿"],
  stateLabels: {},
  visibleTabs: ["workflow", "planning", "runs"],

  documentTypeLabel(snapshot) {
    return `头条创作${snapshot.scenario ? ` · ${snapshot.scenario.label} · ${snapshot.active?.line ?? ""}` : ""}`;
  },

  wordCountHint(snapshot) {
    return snapshot.scenario
      ? `${snapshot.scenario.label} ${snapshot.scenario.length[0]}–${snapshot.scenario.length[1]} 字`
      : "";
  },

  mount(host: WorkbenchShellHost): ProductLineUiSession {
    let deliveryUrl: string | undefined;
    let planDocument: string | undefined;

    function updateNewDocumentTitle(isActiveProject: boolean): void {
      byId("article-options").hidden = !isActiveProject;
      const newDocForm = byId<HTMLFormElement>("new-document");
      const modeSelect = newDocForm.elements.namedItem("mode") as HTMLSelectElement;
      const titleInput = newDocForm.elements.namedItem("title") as HTMLInputElement;
      const titled = isActiveProject && modeSelect.value !== "micro";
      syncTitleCount(titleInput, byId<HTMLOutputElement>("new-title-count"), titled);
    }

    // Bind Toutiao rename bar
    const renameForm = byId<HTMLFormElement>("rename");
    const renameInput = renameForm.elements.namedItem("title") as HTMLInputElement;
    renameInput.addEventListener("input", () =>
      syncTitleCount(renameInput, byId<HTMLOutputElement>("title-count"), true),
    );
    byId<HTMLSelectElement>("title-choices").onchange = (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value) renameInput.value = value;
      syncTitleCount(renameInput, byId<HTMLOutputElement>("title-count"), true);
    };
    host.bindForm("rename", (values) =>
      host.change("article.rename", values, { savedVersion: true, clearDraft: true, message: "标题已更新为新修订" }),
    );

    // Bind Toutiao workflow actions
    host.bindForm("qa", async (values) => {
      const result = await host.change<CandidateQaReport>(
        "article.qa",
        {
          score: Number(values.score),
          passed: values.passed === "on",
          fails: values.fails.split("\n").map((line) => line.trim()).filter(Boolean),
        },
        { savedVersion: true },
      );
      host.notice([...result.hardGates, ...result.fails].join(" · ") || `质检已记录 · ${result.overall} 分`);
    });

    host.bindClick("refine", () =>
      host.change("article.refine", { body: host.readEditorValue() }, { clearDraft: true, message: "已保存回改稿" }),
    );
    host.bindClick("accept", () =>
      host.change("article.accept", { accept: true }, { savedVersion: true, message: "稿件已验收" }),
    );
    host.bindClick("reject", async () => {
      const reason = await host.modal.prompt({
        title: "验收退回",
        message: "填写本次验收退回原因，便于后续修订和核对。",
        label: "退回原因",
        placeholder: "例如：核心数据需补充来源，结尾过渡偏急",
        confirmLabel: "确认退回",
      });
      if (reason !== null) {
        await host.change("article.accept", { accept: false, reason }, { savedVersion: true, message: "已退回修订" });
      }
    });

    host.bindClick("approve", async () => {
      const rev = host.getState().snapshot.active?.revisionId?.slice(0, 8) ?? "";
      const confirmed = await host.modal.confirm({
        title: "批准交稿版本",
        message: `确认批准修订 ${rev} 用于本地 Markdown 交稿导出？批准记录将严格绑定至该版本。`,
        confirmLabel: "确认批准",
      });
      if (confirmed) {
        await host.change("approval.decide", { confirmed: true }, { message: "已批准当前版本交稿" });
      }
    });

    host.bindClick("deliver", async () => {
      const revId = host.getState().snapshot.active?.revisionId ?? "";
      const result = await host.change<{ state: string }>("article.deliver", {
        key: `delivery:${revId}`,
      });
      host.notice(
        result.state === "exported" ? "交稿单已生成并写入本地文件" : "已记录交稿，文件导出失败，可从此处重试。",
        result.state !== "exported",
      );
    });

    // Bind Toutiao planning form
    host.bindForm("article-plan", (values) =>
      host.change("article.plan", values, { message: "场景规划已保存" }),
    );

    return {
      onCreateDocumentFormChanged(isActiveProject) {
        updateNewDocumentTitle(isActiveProject);
      },

      renderDocumentSlots(isActiveProduct: boolean, snapshot: WorkspaceSnapshot) {
        const active = snapshot.active;
        byId("toutiao-actions").hidden = !isActiveProduct;
        byId("article-plan").hidden = !isActiveProduct;
        byId("automatic-qa").hidden = !isActiveProduct;

        if (!isActiveProduct || !active) {
          renameForm.hidden = true;
          planDocument = undefined;
          if (deliveryUrl) {
            URL.revokeObjectURL(deliveryUrl);
            deliveryUrl = undefined;
          }
          byId<HTMLAnchorElement>("download").hidden = true;
          return;
        }

        const hasDraft = Boolean(active.revisionId);
        const locked = active.state === "已验收" || active.state === "已交稿";

        const renameTitleInput = renameForm.elements.namedItem("title") as HTMLInputElement;
        renameForm.hidden = active.mode === "micro" || locked;
        if (renameForm.dataset.title !== active.title) {
          renameForm.dataset.title = active.title;
          renameTitleInput.value = active.title;
        }
        syncTitleCount(renameTitleInput, byId<HTMLOutputElement>("title-count"), !renameForm.hidden);

        const titlesSelect = byId<HTMLSelectElement>("title-choices");
        const plannedTitles = snapshot.planning?.titleMatrix?.valid?.map(({ text }) => text) ?? [];
        if (titlesSelect.dataset.titles !== JSON.stringify(plannedTitles)) {
          titlesSelect.dataset.titles = JSON.stringify(plannedTitles);
          titlesSelect.replaceChildren(
            new Option("套用标题候选", ""),
            ...plannedTitles.map((title) => new Option(title, title)),
          );
        }

        const report = snapshot.report;
        const reportEl = byId("article-report");
        reportEl.hidden = !report;
        reportEl.textContent = report?.overall !== undefined
          ? [`最近质检 ${report.overall} 分`, ...(report.hardGates ?? []), ...(report.fails ?? [])].join(" · ")
          : report
            ? `验收退回 · ${report.reason || "请修订后重新质检"}`
            : "";

        const exportStatus = snapshot.exportStatus;
        const approvedVersion = byId("approved-version");
        approvedVersion.hidden = !snapshot.approved;
        approvedVersion.textContent = snapshot.approved
          ? `获批修订 ${(exportStatus?.revisionId ?? active.revisionId ?? "").slice(0, 8)}`
          : "";

        const exportStatusEl = byId("export-status");
        exportStatusEl.hidden = !exportStatus;
        exportStatusEl.textContent = exportStatus
          ? ({
            exported: "已写入交稿文件",
            pending: "已记录交稿，等待写入文件",
            failed: String(exportStatus.error).includes("export.conflict")
              ? "存在同名的不同文件，请处理冲突后重试"
              : "已记录交稿，文件写入失败",
          })[exportStatus.state]
          : "";

        if (planDocument !== active.id) {
          planDocument = active.id;
          const articlePlan = byId<HTMLFormElement>("article-plan");
          articlePlan.reset();
          const plan = snapshot.planning ?? {};
          if (snapshot.scenario) {
            for (const [name, key] of [["driver", "drivers"], ["opening", "openings"], ["ending", "endings"]] as const) {
              const select = articlePlan.elements.namedItem(name) as HTMLSelectElement;
              select.replaceChildren(...snapshot.scenario[key].map((word) => new Option(word, word)));
              const selectedValue = plan[name];
              if (selectedValue) select.value = selectedValue;
            }
            byId("title-matrix").hidden = !snapshot.scenario.hasTitle;
            const titlesArea = articlePlan.elements.namedItem("titles") as HTMLTextAreaElement;
            titlesArea.value = plan.titleMatrix?.valid.map(({ text, motif }) => `${text} | ${motif}`).join("\n") ?? "";
          }
        }

        byId<HTMLButtonElement>("qa-submit").disabled = !hasDraft || locked;
        byId<HTMLButtonElement>("refine").disabled = !hasDraft || active.state !== "初稿待改" || active.qaRounds >= 2;
        const acceptDisabled = active.state !== "待验收";
        byId<HTMLButtonElement>("accept").disabled = acceptDisabled;
        byId<HTMLButtonElement>("reject").disabled = acceptDisabled;

        const approveBtn = byId<HTMLButtonElement>("approve");
        approveBtn.disabled = active.state !== "已验收" || Boolean(snapshot.approved);
        approveBtn.textContent = snapshot.approved ? "已批准交稿" : "批准交稿";

        const deliverBtn = byId<HTMLButtonElement>("deliver");
        deliverBtn.disabled = !snapshot.approved || !["已验收", "已交稿"].includes(active.state);
        deliverBtn.textContent = active.state === "已交稿" ? "重试或检查导出" : "交稿";

        const download = byId<HTMLAnchorElement>("download");
        if (deliveryUrl) URL.revokeObjectURL(deliveryUrl);
        deliveryUrl = snapshot.delivery
          ? URL.createObjectURL(new Blob([snapshot.delivery], { type: "text/markdown;charset=utf-8" }))
          : undefined;
        download.hidden = !deliveryUrl;
        if (deliveryUrl) download.href = deliveryUrl;
      },
    };
  },
};
