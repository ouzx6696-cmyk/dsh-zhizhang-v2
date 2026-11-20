import type { Product } from "../../../contracts/workspace-dto.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { SEED_PACKS, type SeedPack } from "../seed-packs.ts";
import { el } from "../store.ts";

export interface WizardCallbacks {
  readonly onCompleted: (projectId: string, documentId: string) => Promise<void>;
}

/**
 * 3-step guided new-book / column creation dialog built programmatically inside
 * a dedicated `<dialog>` so cold-start projects ship with skeleton & starter skills.
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
    const box = el("div", "", "modal-card");
    box.append(
      el("p", `三步开新书 · 第 ${step} / 3 步`, "eyebrow"),
      el("h2", step === 1 ? "定产品线与题材" : step === 2 ? "选起步骨架" : "勾选预装种子技法包", "modal-title"),
    );

    const formBody = el("div", "", "stack-form");
    if (step === 1) {
      const nameLabel = el("label", "书名或专栏名称");
      const nameInput = document.createElement("input");
      nameInput.value = bookName;
      nameInput.placeholder = "例如：长风行 / 产业观察室";
      nameInput.oninput = () => {
        bookName = nameInput.value;
      };
      nameLabel.append(nameInput);

      const packLabel = el("label", "题材起步包（自动绑定产品线）");
      const packSelect = document.createElement("select");
      for (const pack of SEED_PACKS) {
        packSelect.append(new Option(`${pack.product === "fanqie" ? "番茄" : "头条"} · ${pack.name}`, pack.id));
      }
      packSelect.value = selectedPackId;
      packSelect.onchange = () => {
        const picked = SEED_PACKS.find((p) => p.id === packSelect.value);
        if (picked) {
          applyPackDefaults(picked);
          paint();
        }
      };
      packLabel.append(packSelect);
      formBody.append(nameLabel, packLabel, el("p", currentPack().summary, "muted-copy"));
    } else if (step === 2) {
      if (product === "fanqie") {
        const volLabel = el("label", "第一卷名称");
        const volInput = document.createElement("input");
        volInput.value = volumeTitle;
        volInput.oninput = () => {
          volumeTitle = volInput.value;
        };
        volLabel.append(volInput);

        const chLabel = el("label", "首章标题");
        const chInput = document.createElement("input");
        chInput.value = firstTitle;
        chInput.oninput = () => {
          firstTitle = chInput.value;
        };
        chLabel.append(chInput);

        const countLabel = el("label", "预创建初始章节数（1–3 章）");
        const countInput = document.createElement("input");
        countInput.type = "number";
        countInput.min = "1";
        countInput.max = "3";
        countInput.value = String(chapterCount);
        countInput.oninput = () => {
          chapterCount = Math.max(1, Math.min(3, Number(countInput.value) || 1));
        };
        countLabel.append(countInput);

        const intentLabel = el("label", "全书指南针（注入 Prefix 稳定区，可随时改）");
        const intentInput = document.createElement("textarea");
        intentInput.rows = 3;
        intentInput.value = authorIntent;
        intentInput.oninput = () => {
          authorIntent = intentInput.value;
        };
        intentLabel.append(intentInput);

        formBody.append(volLabel, chLabel, countLabel, intentLabel);
      } else {
        const modeLabel = el("label", "文章体裁");
        const modeSel = document.createElement("select");
        for (const [m, t] of [["short", "短图文"], ["long", "长图文"], ["micro", "微头条"]] as const) {
          modeSel.append(new Option(t, m));
        }
        modeSel.value = toutiaoMode;
        modeSel.onchange = () => {
          toutiaoMode = modeSel.value as "short" | "long" | "micro";
        };
        modeLabel.append(modeSel);

        const lineLabel = el("label", "内容线");
        const lineSel = document.createElement("select");
        for (const line of ["资讯线", "故事线"]) {
          lineSel.append(new Option(line, line));
        }
        lineSel.value = toutiaoLine;
        lineSel.onchange = () => {
          toutiaoLine = lineSel.value;
        };
        lineLabel.append(lineSel);

        const titleLabel = el("label", "首篇标题（微头条可留空）");
        const titleInput = document.createElement("input");
        titleInput.value = firstTitle;
        titleInput.oninput = () => {
          firstTitle = titleInput.value;
        };
        titleLabel.append(titleInput);

        formBody.append(modeLabel, lineLabel, titleLabel);
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
    box.append(formBody);

    const actions = el("div", "", "modal-actions");
    const cancelBtn = el("button", "取消");
    cancelBtn.type = "button";
    cancelBtn.onclick = () => dlg.close();
    actions.append(cancelBtn);

    if (step > 1) {
      const backBtn = el("button", "上一步");
      backBtn.type = "button";
      backBtn.onclick = () => {
        step = step === 3 ? 2 : 1;
        paint();
      };
      actions.append(backBtn);
    }

    if (step < 3) {
      const nextBtn = el("button", "下一步", "primary");
      nextBtn.type = "button";
      nextBtn.onclick = () => {
        step = step === 1 ? 2 : 3;
        paint();
      };
      actions.append(nextBtn);
    } else {
      const submitBtn = el("button", "创建并进入写作", "primary");
      submitBtn.type = "button";
      submitBtn.onclick = () => void host.perform(finishWizard);
      actions.append(submitBtn);
    }

    box.append(actions);
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
