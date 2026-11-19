// Accessible native <dialog> controller replacing browser window.confirm/window.prompt.

export interface ConfirmDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

export interface PromptDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

function getDialog(): HTMLDialogElement {
  const el = document.getElementById("app-dialog");
  if (!(el instanceof HTMLDialogElement)) {
    throw new Error("Missing #app-dialog element");
  }
  return el;
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  const dialog = getDialog();
  return new Promise<boolean>((resolve) => {
    const title = document.createElement("h3");
    title.className = "dialog-title";
    title.textContent = options.title;

    const message = document.createElement("p");
    message.className = "dialog-message";
    message.textContent = options.message;

    const body = document.createElement("div");
    body.className = "dialog-body";
    body.append(title, message);

    if (options.details && options.details.length > 0) {
      const list = document.createElement("ul");
      list.className = "dialog-list";
      for (const item of options.details) {
        const li = document.createElement("li");
        li.textContent = item;
        list.append(li);
      }
      body.append(list);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = options.cancelLabel ?? "取消";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = options.danger ? "danger" : "primary";
    confirmBtn.textContent = options.confirmLabel ?? "确认";

    actions.append(cancelBtn, confirmBtn);
    body.append(actions);
    dialog.replaceChildren(body);

    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(accepted);
    };

    const onCancel = (event: Event) => {
      event.preventDefault();
      finish(false);
    };
    const onClose = () => finish(false);

    cancelBtn.onclick = () => finish(false);
    confirmBtn.onclick = () => finish(true);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    confirmBtn.focus();
  });
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  const dialog = getDialog();
  return new Promise<string | null>((resolve) => {
    const form = document.createElement("form");
    form.className = "dialog-body";

    const title = document.createElement("h3");
    title.className = "dialog-title";
    title.textContent = options.title;

    const message = document.createElement("p");
    message.className = "dialog-message";
    message.textContent = options.message;

    const label = document.createElement("label");
    label.className = "dialog-field";
    label.textContent = options.label;

    const input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = options.placeholder ?? "";
    input.value = options.initialValue ?? "";
    label.append(input);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = options.cancelLabel ?? "取消";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "submit";
    confirmBtn.className = "primary";
    confirmBtn.textContent = options.confirmLabel ?? "确认";

    actions.append(cancelBtn, confirmBtn);
    form.append(title, message, label, actions);
    dialog.replaceChildren(form);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };

    const onCancel = (event: Event) => {
      event.preventDefault();
      finish(null);
    };
    const onClose = () => finish(null);

    cancelBtn.onclick = () => finish(null);
    form.onsubmit = (event) => {
      event.preventDefault();
      finish(input.value);
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    input.focus();
  });
}
