import { WORKSPACE_TITLE_MAX } from "../../../contracts/workspace.ts";
import type { WorkbenchStore } from "../store.ts";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function formValues(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function updateTitleCounter(
  field: HTMLInputElement,
  output: HTMLElement,
  titled: boolean,
): void {
  const length = [...field.value.trim()].length;
  output.textContent = titled ? `${length} / ${WORKSPACE_TITLE_MAX} 字符` : "";
  output.classList.toggle("over-limit", titled && length > WORKSPACE_TITLE_MAX);
  field.setCustomValidity(titled && length > WORKSPACE_TITLE_MAX ? `标题最多 ${WORKSPACE_TITLE_MAX} 个字符` : "");
}

export interface DirectoryController {
  readonly chapterTitles: Map<string, string>;
  render(): void;
}

export function createDirectoryView(
  store: WorkbenchStore,
  onDirectoryChanged: (chapterTitles: ReadonlyMap<string, string>) => void,
): DirectoryController {
  const projectsSelect = byId<HTMLSelectElement>("projects");
  const navigation = byId<HTMLElement>("documents");
  const documentTools = byId<HTMLElement>("document-tools");
  const articleOptions = byId<HTMLElement>("article-options");
  const newProjectForm = byId<HTMLFormElement>("new-project");
  const newDocumentForm = byId<HTMLFormElement>("new-document");
  const newTitleCount = byId<HTMLElement>("new-title-count");
  const breadcrumbProject = byId<HTMLElement>("breadcrumb-project");
  const breadcrumbDocument = byId<HTMLElement>("breadcrumb-document");
  const emptyActionFanqie = document.getElementById("empty-new-fanqie");
  const emptyActionToutiao = document.getElementById("empty-new-toutiao");

  let directoryKey = "";
  let selectedButton: HTMLButtonElement | undefined;
  let buttons = new Map<string, HTMLButtonElement>();
  const chapterTitles = new Map<string, string>();

  function updateNewTitle(): void {
    const modeSelect = newDocumentForm.elements.namedItem("mode") as HTMLSelectElement;
    const titleInput = newDocumentForm.elements.namedItem("title") as HTMLInputElement;
    const titled = !articleOptions.hidden && modeSelect.value !== "micro";
    titleInput.placeholder = articleOptions.hidden
      ? "章节标题，如：第一章"
      : modeSelect.value === "micro"
        ? "微头条无需标题"
        : "请输入 1–34 字符标题";
    titleInput.disabled = !articleOptions.hidden && modeSelect.value === "micro";
    if (titleInput.disabled) titleInput.value = "";
    updateTitleCounter(titleInput, newTitleCount, titled);
  }

  newDocumentForm.addEventListener("input", updateNewTitle);
  newDocumentForm.addEventListener("change", updateNewTitle);

  projectsSelect.onchange = () => {
    const selected = projectsSelect.value;
    void store.perform(async () => {
      store.stashCurrentEditor();
      store.projectId = selected;
      store.documentId = "";
      await store.load();
    });
  };

  newProjectForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      store.stashCurrentEditor();
      const values = formValues(newProjectForm);
      const created = await store.mutate<{ id: string }>("project.create", values);
      store.projectId = created.id;
      store.documentId = "";
      newProjectForm.reset();
      await store.load();
    });
  };

  newDocumentForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      store.stashCurrentEditor();
      const values = formValues(newDocumentForm);
      const created = await store.mutate<{ id: string }>("document.create", {
        ...values,
        projectId: store.projectId,
      });
      store.documentId = created.id;
      newDocumentForm.reset();
      await store.load();
    });
  };

  function openQuickCreateProject(product: "fanqie" | "toutiao"): void {
    const details = newProjectForm.closest("details");
    if (details) details.open = true;
    const productSelect = newProjectForm.elements.namedItem("product") as HTMLSelectElement | null;
    if (productSelect) productSelect.value = product;
    const nameInput = newProjectForm.elements.namedItem("name") as HTMLInputElement | null;
    nameInput?.focus();
  }

  emptyActionFanqie?.addEventListener("click", () => openQuickCreateProject("fanqie"));
  emptyActionToutiao?.addEventListener("click", () => openQuickCreateProject("toutiao"));

  function render(): void {
    const snapshot = store.snapshot;
    const project = snapshot.projects.find((item) => item.id === store.projectId);
    const article = project?.product === "toutiao";

    breadcrumbProject.textContent = project ? project.name : "未选择项目";
    breadcrumbDocument.textContent = snapshot.active ? (snapshot.active.title || "微头条") : "";

    const nextKey = JSON.stringify([store.projectId, snapshot.projects, snapshot.documents]);
    if (nextKey !== directoryKey) {
      directoryKey = nextKey;

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "选择项目";
      projectsSelect.replaceChildren(
        placeholder,
        ...snapshot.projects.map((item) => {
          const opt = document.createElement("option");
          opt.value = item.id;
          opt.textContent = `${item.name} · ${item.product === "fanqie" ? "番茄" : "头条"}`;
          return opt;
        }),
      );

      buttons = new Map();
      chapterTitles.clear();
      for (const item of snapshot.documents ?? []) {
        const label = item.title || "微头条";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "doc-item";
        button.textContent = label;
        button.setAttribute("aria-current", "false");
        button.onclick = () => {
          void store.perform(async () => {
            store.stashCurrentEditor();
            const knownOutput = document.getElementById("known-settings");
            knownOutput?.replaceChildren();
            store.documentId = item.id;
            await store.load();
          });
        };
        buttons.set(item.id, button);
        chapterTitles.set(item.id, label);
      }

      if (buttons.size > 0) {
        navigation.replaceChildren(...buttons.values());
      } else if (project) {
        const hint = document.createElement("p");
        hint.className = "muted-hint";
        hint.textContent = "尚无稿件，可在下方新建。";
        navigation.replaceChildren(hint);
      } else {
        navigation.replaceChildren();
      }
      onDirectoryChanged(chapterTitles);
    }

    projectsSelect.value = store.projectId;
    const activeButton = buttons.get(store.documentId);
    if (activeButton !== selectedButton) {
      selectedButton?.setAttribute("aria-current", "false");
      activeButton?.setAttribute("aria-current", "true");
      selectedButton = activeButton;
    }

    documentTools.hidden = !project;
    articleOptions.hidden = !article;
    updateNewTitle();
  }

  return { chapterTitles, render };
}
