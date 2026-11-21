import type {
  ProjectExportBundleDto,
  ProjectImportSummaryDto,
} from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { el } from "../store.ts";
import { createButton, createCard } from "../ui/primitives.ts";

export function createIoView(container: HTMLElement, host: WorkbenchShellHost) {
  let lastExport: ProjectExportBundleDto | null = null;
  let lastImportSummary: ProjectImportSummaryDto | null = null;

  function triggerDownload(filename: string, contents: string, mime = "application/json;charset=utf-8"): void {
    const url = URL.createObjectURL(new Blob([contents], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function refresh(): void {
    const { projectId, snapshot } = host.getState();
    const project = snapshot.projects?.find((p) => p.id === projectId);
    container.replaceChildren();

    const header = el("header", "", "view-header");
    const left = el("div");
    left.append(
      el("p", "SQLite 单一真源 · 卷/幕/章 Markdown 目录双向同步", "eyebrow"),
      el("h1", "长篇本地项目导入与导出"),
    );
    header.append(left);
    container.append(header);

    // Export card
    const exportBody: HTMLElement[] = [];
    if (!project || project.product !== "fanqie") {
      exportBody.push(el("p", "请先打开一个番茄连载项目即可导出整书工程。", "muted-copy"));
    } else {
      const actions = el("div", "", "actions");
      actions.append(
        createButton({
          label: "打包导出整书 JSON 资产包",
          variant: "primary",
          onClick: () =>
            void host.perform(async () => {
              const bundle = await host.request<ProjectExportBundleDto>("project.export_bundle", { projectId });
              lastExport = bundle;
              triggerDownload(`${project.name}-zhizhang-bundle.json`, JSON.stringify(bundle, null, 2));
              host.notice(`已打包 ${bundle.files.length} 个文件`);
              refresh();
            }),
        }),
        createButton({
          label: "写入本地工作区目录（exports/）",
          variant: "secondary",
          onClick: () =>
            void host.perform(async () => {
              const bundle = await host.request<ProjectExportBundleDto>("project.export_bundle", {
                projectId,
                writeToDisk: true,
              });
              lastExport = bundle;
              host.notice(
                bundle.writtenDirectory
                  ? `已导出到目录：${bundle.writtenDirectory}`
                  : "已生成导出包（当前预览环境未配置磁盘导出根路径，可下载 JSON 包）",
              );
              refresh();
            }),
        }),
      );
      exportBody.push(actions);
    }

    if (lastExport) {
      exportBody.push(
        el(
          "p",
          `最近导出：${lastExport.projectName} · 共 ${lastExport.files.length} 个文件${lastExport.writtenDirectory ? ` · 目录 ${lastExport.writtenDirectory}` : ""}`,
          "setting-meta",
        ),
      );
      const list = el("ul", "", "modal-list");
      for (const file of lastExport.files.slice(0, 30)) {
        list.append(el("li", `${file.path}（${file.content.length} 字符）`));
      }
      exportBody.push(list);
    }

    container.append(
      createCard({
        tag: "section",
        variant: "default",
        padding: "md",
        title: "导出本书工程（Markdown 目录 + 结构化资产包）",
        body: exportBody,
      }),
    );

    // Import card
    const importBody: HTMLElement[] = [
      el("p", "支持选择本地小说目录（含卷/幕/章 `.md` 与可选 `zhizhang-project.json`）。已定稿章节（final）与已锁定设定会自动跳过保护。", "muted-copy"),
    ];

    const targetCheckLabel = el("label", "", "check");
    const mergeCurrentCheck = document.createElement("input");
    mergeCurrentCheck.type = "checkbox";
    mergeCurrentCheck.checked = Boolean(project && project.product === "fanqie");
    targetCheckLabel.append(mergeCurrentCheck, document.createTextNode("合并更新到当前打开的项目（取消勾选则新建独立项目）"));

    const dirLabel = el("label", "选择本地文件夹导入（Chrome / Edge / Safari）", "ui-field");
    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.className = "ui-input";
    dirInput.multiple = true;
    (dirInput as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    dirInput.onchange = () => {
      const selected = Array.from(dirInput.files ?? []);
      if (selected.length === 0) return;
      void host.perform(async () => {
        const files: { path: string; content: string }[] = [];
        for (const file of selected) {
          const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
          const parts = rel.replace(/\\/g, "/").split("/");
          const stripped = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
          if (!stripped.endsWith(".md") && !stripped.endsWith(".json")) continue;
          if (stripped === "export-manifest.json") continue;
          files.push({ path: stripped, content: await file.text() });
        }
        const summary = await host.request<ProjectImportSummaryDto>("project.import_bundle", {
          ...(mergeCurrentCheck.checked && project?.product === "fanqie" ? { projectId: project.id } : {}),
          files,
        });
        lastImportSummary = summary;
        host.notice(`导入完成：新建 ${summary.chaptersCreated} 章，更新 ${summary.chaptersUpdated} 章`);
        await host.load();
        refresh();
      });
    };
    dirLabel.append(dirInput);

    const jsonLabel = el("label", "或选择导出的 `.json` 资产包文件导入", "ui-field");
    const jsonInput = document.createElement("input");
    jsonInput.type = "file";
    jsonInput.className = "ui-input";
    jsonInput.accept = ".json,application/json";
    jsonInput.onchange = () => {
      const file = jsonInput.files?.[0];
      if (!file) return;
      void host.perform(async () => {
        const parsed = JSON.parse(await file.text()) as { files?: { path: string; content: string }[]; projectName?: string };
        if (!Array.isArray(parsed.files)) throw new Error("资产包格式无效：缺少 files 数组。");
        const summary = await host.request<ProjectImportSummaryDto>("project.import_bundle", {
          ...(mergeCurrentCheck.checked && project?.product === "fanqie" ? { projectId: project.id } : {}),
          projectName: parsed.projectName,
          files: parsed.files,
        });
        lastImportSummary = summary;
        host.notice(`资产包导入完成：新建 ${summary.chaptersCreated} 章，更新 ${summary.chaptersUpdated} 章`);
        await host.load();
        refresh();
      });
    };
    jsonLabel.append(jsonInput);

    importBody.push(targetCheckLabel, dirLabel, jsonLabel);

    if (lastImportSummary) {
      const s = lastImportSummary;
      importBody.push(
        el(
          "p",
          `导入汇总：新建卷 ${s.volumesCreated} · 幕 ${s.actsCreated} · 新建章 ${s.chaptersCreated} · 更新章 ${s.chaptersUpdated} · 已定稿跳过 ${s.chaptersSkippedLocked.length} · 设定待审提案 ${s.loreProposed} · 库条目 ${s.libraryImported}`,
          "qa-summary",
        ),
      );
    }

    container.append(
      createCard({
        tag: "section",
        variant: "default",
        padding: "md",
        title: "从本地文件夹或资产包导入",
        body: importBody,
      }),
    );
  }

  return { refresh };
}
