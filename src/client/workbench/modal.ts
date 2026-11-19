export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
}

export interface PromptOptions {
  readonly title: string;
  readonly message: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

/**
 * Accessible custom `<dialog>` controller replacing all native `window.confirm`
 * and `window.prompt` calls (which break inside strict DsH / iframe sandboxes).
 */
export function createModalController(dialog: HTMLDialogElement) {
  let pendingClose: ((value: unknown) => void) | null = null;

  function resetDialog(): void {
    dialog.replaceChildren();
    dialog.oncancel = null;
  }

  function openAndAwait<T>(build: (finish: (value: T) => void) => void, cancelValue: T): Promise<T> {
    if (pendingClose) {
      pendingClose(cancelValue);
      pendingClose = null;
    }
    if (dialog.open) dialog.close();
    resetDialog();

    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        pendingClose = null;
        if (dialog.open) dialog.close();
        resolve(value);
      };
      pendingClose = finish as (value: unknown) => void;
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(cancelValue);
      };
      build(finish);
      dialog.showModal();
    });
  }

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return openAndAwait<boolean>((finish) => {
      const box = document.createElement("div");
      box.className = "modal-card";

      const heading = document.createElement("h2");
      heading.className = "modal-title";
      heading.textContent = options.title;
      box.append(heading);

      const desc = document.createElement("p");
      desc.className = "modal-message";
      desc.textContent = options.message;
      box.append(desc);

      if (options.details && options.details.length > 0) {
        const list = document.createElement("ul");
        list.className = "modal-list";
        for (const item of options.details) {
          const li = document.createElement("li");
          li.textContent = item;
          list.append(li);
        }
        box.append(list);
      }

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = options.cancelLabel ?? "取消";
      cancelBtn.onclick = () => finish(false);

      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = options.destructive ? "danger" : "primary";
      okBtn.textContent = options.confirmLabel ?? "确认";
      okBtn.onclick = () => finish(true);

      actions.append(cancelBtn, okBtn);
      box.append(actions);
      dialog.append(box);
      okBtn.focus();
    }, false);
  }

  function prompt(options: PromptOptions): Promise<string | null> {
    return openAndAwait<string | null>((finish) => {
      const form = document.createElement("form");
      form.className = "modal-card";

      const heading = document.createElement("h2");
      heading.className = "modal-title";
      heading.textContent = options.title;
      form.append(heading);

      const desc = document.createElement("p");
      desc.className = "modal-message";
      desc.textContent = options.message;
      form.append(desc);

      const fieldLabel = document.createElement("label");
      fieldLabel.className = "modal-field";
      fieldLabel.textContent = options.label;
      const textarea = document.createElement("textarea");
      textarea.rows = 3;
      textarea.placeholder = options.placeholder ?? "";
      textarea.value = options.initialValue ?? "";
      fieldLabel.append(textarea);
      form.append(fieldLabel);

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = options.cancelLabel ?? "取消";
      cancelBtn.onclick = () => finish(null);

      const okBtn = document.createElement("button");
      okBtn.type = "submit";
      okBtn.className = "primary";
      okBtn.textContent = options.confirmLabel ?? "确认提交";

      actions.append(cancelBtn, okBtn);
      form.append(actions);
      form.onsubmit = (event) => {
        event.preventDefault();
        finish(textarea.value);
      };
      dialog.append(form);
      textarea.focus();
    }, null);
  }

  return { confirm, prompt };
}

export type ModalController = ReturnType<typeof createModalController>;
