import type { Product } from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { SEED_PACKS, type SeedPack } from "../seed-packs.ts";
import { el } from "../store.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

export interface WizardCallbacks {
  readonly onCompleted: (projectId: string, documentId: string) => Promise<void>;
}

/**
 * 3-step guided new-book / column creation dialog built programmatically inside
 * a dedicated `<dialog>` using the unified Button, Input, and Card primitives.
 */
export function createNewBookWizard(host: WorkbenchShellHost, callbacks: WizardCallbacks) {
  let dialog: HTMLDialogElement | null = null;
  let step: 1 | 2 | 3 = 1;
  let product: Product = "fanqie";
  let bookName = "";
  let selectedPackId = SEED_PACKS[0].id;
  let volumeTitle = SEED_PACKS[0].defaultVolumeTitle;
  let chapterCount = 1;
  let authorIntent = SEED_PACKS[0].defaultAuthorIntent;
  let toutiaoMode: "short" | "long" | "micro" = "short";
  let toutiaoLine = "资讯线";
  let firstTitle = SEED_PACKS[0].firstChapterTitle;
  const checkedTechniques = new Set<string>(SEED_PACKS[0].techniques.map((t) => t.id));

  function currentPack(): SeedPack {
    return SEED_PACKS.find((p) => p.id === selectedPackId) ?? SEED_PACKS[0];
  }

  function applyPackDefaults(pack: SeedPack): void {
    selectedPackId = pack.id;
    product = pack.product;
    volumeTitle = pack.defaultVolumeTitle;
    authorIntent = pack.defaultAuthorIntent;
    firstTitle = pack.firstChapterTitle;
    checkedTechniques.clear();
    for (const tech of pack.techniques) checkedTechniques.add(tech.id);
  }

  function ensureDialog(): HTMLDialogElement {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "modal-dialog wizard-dialog";
      dialog.setAttribute("aria-modal", "true");
      document.body.append(dialog);
    }
    return dialog;
  }

  async function finishWizard(): Promise<void> {
    const cleanName = bookName.trim() || (product === "fanqie" ? "新长篇项目" : "新头条专栏");
    const pack = currentPack();
    const proj = await host.request<{ id: string }>("project.create", { product, name: cleanName });
    const projectId = proj.id;

    let firstDocId = "";
    if (product === "fanqie") {
      await host.request("controls.save", { projectId, authorIntent });
      const vol = await host.request<{ id: string }>("volume.create", {
        projectId,
        title: volumeTitle.trim() || "第一卷",
      });
      const total = Math.max(1, Math.min(3, chapterCount));
      for (let i = 1; i <= total; i++) {
        const chTitle = i === 1 ? (firstTitle.trim() || "第一章") : `第${i}章`;
        const doc = await host.request<{ id: string }>("document.create", {
          projectId,
          title: chTitle,
          volumeId: vol.id,
        });
        if (i === 1) {
          firstDocId = doc.id;
          if (pack.firstChapterLead.trim()) {
            await host.request("draft.save", {
              documentId: doc.id,
              baseRevisionId: null,
              body: pack.firstChapterLead,
            });
          }
        }
      }
      for (const preset of pack.techniques) {
        if (!checkedTechniques.has(preset.id)) continue;
        const card = await host.request<{ id: string }>("technique.save", {
          scope: "project",
          projectId,
          title: preset.title,
          category: preset.category,
          pacing: preset.pacing,
          sceneTags: preset.sceneTags,
          triggerWhen: preset.triggerWhen,
          executionSteps: preset.executionSteps,
          constraints: preset.constraints,
          antiPatterns: preset.antiPatterns,
        });
        await host.request("library.mount", {
          projectId,
          targetType: "project",
          targetId: projectId,
          itemKind: "technique",
          itemId: card.id,
          mode: "include",
        });
      }
    } else {
      const doc = await host.request<{ id: string }>("document.create", {
        projectId,
        title: toutiaoMode === "micro" ? "" : (firstTitle.trim() || "首篇选题"),
        mode: toutiaoMode,
        line: toutiaoLine,
      });
      firstDocId = doc.id;
      if (pack.firstChapterLead.trim()) {
        await host.request("draft.save", {
          documentId: doc.id,
          baseRevisionId: null,
          body: pack.firstChapterLead,
        });
      }
    }

    dialog?.close();
    await callbacks.onCompleted(projectId, firstDocId);
    host.notice(`已创建「${cleanName}」并完成起步装配`);
  }

  function paint(): void {
    const dlg = ensureDialog();
    dlg.replaceChildren();

    const formBody = el("div", "", "stack-form");
    if (step === 1) {
      const nameField = createInput({
        kind: "text",
        label: "书名或专栏名称",
        value: bookName,
        placeholder: "例如：长风行 / 产业观察室",
        onInput: (val) => {
          bookName = val;
        },
      });
      const packField = createInput({
        kind: "select",
        label: "题材起步包（自动绑定产品线）",
        value: selectedPackId,
        options: SEED_PACKS.map((pack) => ({
          value: pack.id,
          label: `${pack.product === "fanqie" ? "番茄" : "头条"} · ${pack.name}`,
        })),
        hint: currentPack().summary,
        onChange: (val) => {
          const picked = SEED_PACKS.find((p) => p.id === val);
          if (picked) {
            applyPackDefaults(picked);
            paint();
          }
        },
      });
      formBody.append(nameField.root, packField.root);
    } else if (step === 2) {
      if (product === "fanqie") {
        const volField = createInput({
          kind: "text",
          label: "第一卷名称",
          value: volumeTitle,
          onInput: (val) => {
            volumeTitle = val;
          },
        });
        const chField = createInput({
          kind: "text",
          label: "首章标题",
          value: firstTitle,
          onInput: (val) => {
            firstTitle = val;
          },
        });
        const countField = createInput({
          kind: "number",
          label: "预创建初始章节数（1–3 章）",
          min: "1",
          max: "3",
          value: String(chapterCount),
          onInput: (val) => {
            chapterCount = Math.max(1, Math.min(3, Number(val) || 1));
          },
        });
        const intentField = createInput({
          kind: "textarea",
          label: "全书指南针（注入 Prefix 稳定区，可随时改）",
          rows: 3,
          value: authorIntent,
          onInput: (val) => {
            authorIntent = val;
          },
        });
        formBody.append(volField.root, chField.root, countField.root, intentField.root);
      } else {
        const modeField = createInput({
          kind: "select",
          label: "文章体裁",
          value: toutiaoMode,
          options: [
            { value: "short", label: "短图文" },
            { value: "long", label: "长图文" },
            { value: "micro", label: "微头条" },
          ],
          onChange: (val) => {
            toutiaoMode = val as "short" | "long" | "micro";
          },
        });
        const lineField = createInput({
          kind: "select",
          label: "内容线",
          value: toutiaoLine,
          options: [
            { value: "资讯线", label: "资讯线" },
            { value: "故事线", label: "故事线" },
          ],
          onChange: (val) => {
            toutiaoLine = val;
          },
        });
        const titleField = createInput({
          kind: "text",
          label: "首篇标题（微头条可留空）",
          value: firstTitle,
          onInput: (val) => {
            firstTitle = val;
          },
        });
        formBody.append(modeField.root, lineField.root, titleField.root);
      }
    } else {
      const pack = currentPack();
      for (const preset of pack.techniques) {
        const label = el("label", "", "check");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checkedTechniques.has(preset.id);
        cb.onchange = () => {
          if (cb.checked) checkedTechniques.add(preset.id);
          else checkedTechniques.delete(preset.id);
        };
        label.append(cb, document.createTextNode(`${preset.title}（${preset.pacing}）— ${preset.triggerWhen}`));
        formBody.append(label);
      }
    }

    const actions = el("div", "", "modal-actions");
    actions.append(
      createButton({
        label: "取消",
        variant: "secondary",
        onClick: () => dlg.close(),
      }),
    );

    if (step > 1) {
      actions.append(
        createButton({
          label: "上一步",
          variant: "secondary",
          onClick: () => {
            step = step === 3 ? 2 : 1;
            paint();
          },
        }),
      );
    }

    if (step < 3) {
      actions.append(
        createButton({
          label: "下一步",
          variant: "primary",
          onClick: () => {
            step = step === 1 ? 2 : 3;
            paint();
          },
        }),
      );
    } else {
      actions.append(
        createButton({
          label: "创建并进入写作",
          variant: "primary",
          onClick: () => void host.perform(finishWizard),
        }),
      );
    }

    const box = createCard({
      variant: "elevated",
      padding: "lg",
      tag: "div",
      eyebrow: `三步开新书 · 第 ${step} / 3 步`,
      title: step === 1 ? "定产品线与题材" : step === 2 ? "选起步骨架" : "勾选预装种子技法包",
      body: formBody,
      footer: actions,
      className: "modal-card",
    });
    dlg.append(box);
  }

  return {
    open(): void {
      step = 1;
      bookName = "";
      applyPackDefaults(SEED_PACKS[0]);
      paint();
      ensureDialog().showModal();
    },
  };
}
