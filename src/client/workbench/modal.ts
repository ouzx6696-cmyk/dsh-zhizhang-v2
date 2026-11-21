import { createButton, createCard, createInput } from "./ui/primitives.ts";

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
  let pendingCancel: (() => void) | null = null;

  function resetDialog(): void {
    dialog.replaceChildren();
    dialog.oncancel = null;
  }

  function openAndAwait<T>(
    build: (finish: (value: T) => void) => HTMLElement | null,
    cancelValue: T,
  ): Promise<T> {
    if (pendingCancel) {
      const cancelPrevious = pendingCancel;
      pendingCancel = null;
      cancelPrevious();
    }
    if (dialog.open) dialog.close();
    resetDialog();

    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        pendingCancel = null;
        if (dialog.open) dialog.close();
        resolve(value);
      };
      pendingCancel = () => finish(cancelValue);
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(cancelValue);
      };
      const focusTarget = build(finish);
      dialog.showModal();
      focusTarget?.focus();
    });
  }

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return openAndAwait<boolean>((finish) => {
      const bodyNodes: HTMLElement[] = [];
      if (options.details && options.details.length > 0) {
        const list = document.createElement("ul");
        list.className = "modal-list";
        for (const item of options.details) {
          const li = document.createElement("li");
          li.textContent = item;
          list.append(li);
        }
        bodyNodes.push(list);
      }

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = createButton({
        label: options.cancelLabel ?? "取消",
        variant: "secondary",
        onClick: () => finish(false),
      });

      const okBtn = createButton({
        label: options.confirmLabel ?? "确认",
        variant: options.destructive ? "danger" : "primary",
        onClick: () => finish(true),
      });

      actions.append(cancelBtn, okBtn);

      const card = createCard({
        tag: "div",
        variant: "elevated",
        padding: "lg",
        className: "modal-card",
        title: options.title,
        subtitle: options.message,
        ...(bodyNodes.length > 0 ? { body: bodyNodes } : {}),
        footer: actions,
      });

      dialog.append(card);
      return okBtn;
    }, false);
  }

  function prompt(options: PromptOptions): Promise<string | null> {
    return openAndAwait<string | null>((finish) => {
      const form = document.createElement("form");
      form.className = "modal-form";

      const field = createInput({
        kind: "textarea",
        label: options.label,
        rows: 3,
        placeholder: options.placeholder ?? "",
        value: options.initialValue ?? "",
        className: "modal-field",
      });

      const actions = document.createElement("div");
      actions.className = "modal-actions";

      const cancelBtn = createButton({
        label: options.cancelLabel ?? "取消",
        variant: "secondary",
        onClick: () => finish(null),
      });

      const okBtn = createButton({
        label: options.confirmLabel ?? "确认提交",
        variant: "primary",
        type: "submit",
      });

      actions.append(cancelBtn, okBtn);

      const card = createCard({
        tag: "div",
        variant: "elevated",
        padding: "lg",
        className: "modal-card",
        title: options.title,
        subtitle: options.message,
        body: field.root,
        footer: actions,
      });

      form.append(card);
      form.onsubmit = (event) => {
        event.preventDefault();
        finish(field.getValue());
      };
      dialog.append(form);
      return field.control;
    }, null);
  }

  return { confirm, prompt };
}

export type ModalController = ReturnType<typeof createModalController>;
