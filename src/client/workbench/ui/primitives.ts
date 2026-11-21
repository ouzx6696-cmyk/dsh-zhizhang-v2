/**
 * Unified Foundation UI Component Kit (`zhizhang/3.0`).
 *
 * Provides consistent DOM primitives for Button, Input, Card, and Navbar that
 * share one corner-radius grammar, elevation shadow ladder, and tactile click
 * press animation across all workbench views and themes.
 */

export type UiButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type UiButtonSize = "sm" | "md" | "lg";

export interface UiButtonOptions {
  readonly label: string;
  readonly variant?: UiButtonVariant;
  readonly size?: UiButtonSize;
  readonly type?: "button" | "submit" | "reset";
  readonly id?: string;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly pressed?: boolean;
  readonly selected?: boolean;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly onClick?: (event: MouseEvent) => void;
}

export type UiInputKind = "text" | "search" | "number" | "email" | "textarea" | "select";

export interface UiSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface UiInputOptions {
  readonly kind?: UiInputKind;
  readonly label?: string;
  readonly name?: string;
  readonly id?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly rows?: number;
  readonly min?: string;
  readonly max?: string;
  readonly maxLength?: number;
  readonly ariaLabel?: string;
  readonly options?: readonly UiSelectOption[];
  readonly className?: string;
  readonly onInput?: (value: string, event: Event) => void;
  readonly onChange?: (value: string, event: Event) => void;
}

export interface UiInputResult<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement,
> {
  readonly root: HTMLElement;
  readonly control: T;
  readonly getValue: () => string;
  readonly setValue: (next: string) => void;
  readonly setError: (message: string | null) => void;
}

export type UiCardVariant = "default" | "elevated" | "interactive" | "subtle";
export type UiCardPadding = "sm" | "md" | "lg";

export interface UiCardOptions {
  readonly variant?: UiCardVariant;
  readonly padding?: UiCardPadding;
  readonly tag?: "article" | "section" | "div";
  readonly eyebrow?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly headerAction?: HTMLElement;
  readonly body?: HTMLElement | readonly HTMLElement[];
  readonly footer?: HTMLElement | readonly HTMLElement[];
  readonly className?: string;
  readonly onClick?: (event: MouseEvent) => void;
}

export interface UiNavbarTab {
  readonly id: string;
  readonly label: string;
}

export interface UiNavbarOptions {
  readonly brandLabel: string;
  readonly brandHref?: string;
  readonly breadcrumb?: string;
  readonly tabs?: readonly UiNavbarTab[];
  readonly activeTabId?: string;
  readonly actions?: readonly HTMLElement[];
  readonly onTabChange?: (tabId: string) => void;
  readonly onBrandClick?: (event: MouseEvent) => void;
}

export interface UiNavbarController {
  readonly root: HTMLElement;
  readonly setBreadcrumb: (text: string) => void;
  readonly setActiveTab: (tabId: string) => void;
  readonly setScrolled: (scrolled: boolean) => void;
}

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function attachSafeAttr(node: HTMLElement, name: string, value: string): void {
  if (typeof node.setAttribute === "function") {
    node.setAttribute(name, value);
  }
}

/**
 * Triggers a short-lived CSS tactile press state for keyboard activation
 * (`Space` / `Enter`) so keyboard users get the exact same micro-compression
 * feedback as pointer clicks.
 */
function bindKeyboardPressFeedback(target: HTMLElement): void {
  if (typeof target.addEventListener !== "function") return;
  target.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      attachSafeAttr(target, "data-pressing", "true");
    }
  });
  const release = () => {
    if (typeof target.removeAttribute === "function") {
      target.removeAttribute("data-pressing");
    }
  };
  target.addEventListener("keyup", release);
  target.addEventListener("blur", release);
}

/**
 * Unified Button primitive (`data-ui="button"`).
 * Shares unified control border-radius, elevation shadow ladder, and press motion.
 */
export function createButton(options: UiButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? "secondary";
  const size = options.size ?? "md";
  const btn = document.createElement("button");
  btn.type = options.type ?? "button";
  btn.textContent = options.label;

  const semanticCompat =
    variant === "primary"
      ? "primary"
      : variant === "danger"
        ? "danger"
        : "";

  btn.className = joinClasses(
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    semanticCompat,
    options.active && "active",
    options.className,
  );
  attachSafeAttr(btn, "data-ui", "button");
  attachSafeAttr(btn, "data-variant", variant);
  attachSafeAttr(btn, "data-size", size);

  if (options.id) btn.id = options.id;
  if (options.title) btn.title = options.title;
  if (options.ariaLabel) attachSafeAttr(btn, "aria-label", options.ariaLabel);
  if (options.pressed !== undefined) attachSafeAttr(btn, "aria-pressed", String(options.pressed));
  if (options.selected !== undefined) attachSafeAttr(btn, "aria-selected", String(options.selected));
  if (options.disabled) btn.disabled = true;

  if (options.dataset && btn.dataset) {
    for (const [k, v] of Object.entries(options.dataset)) {
      btn.dataset[k] = v;
    }
  }
  if (options.onClick) {
    btn.onclick = options.onClick;
  }

  bindKeyboardPressFeedback(btn);
  return btn;
}

/**
 * Unified Input / Textarea / Select field primitive (`data-ui="input"`).
 * Applies consistent corner radius, subtle inset depth, focus aura, and error state.
 */
export function createInput(options: UiInputOptions): UiInputResult {
  const kind = options.kind ?? "text";
  const wrapper = document.createElement("label");
  wrapper.className = joinClasses("ui-field", options.className);
  attachSafeAttr(wrapper, "data-ui", "field");

  if (options.label) {
    const labelSpan = document.createElement("span");
    labelSpan.className = "ui-field-label";
    labelSpan.textContent = options.label;
    wrapper.append(labelSpan);
  }

  let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (kind === "textarea") {
    const ta = document.createElement("textarea");
    ta.className = "ui-input ui-textarea";
    if (options.rows !== undefined) ta.rows = options.rows;
    control = ta;
  } else if (kind === "select") {
    const sel = document.createElement("select");
    sel.className = "ui-input ui-select";
    for (const opt of options.options ?? []) {
      const optionEl = document.createElement("option");
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      sel.append(optionEl);
    }
    control = sel;
  } else {
    const inp = document.createElement("input");
    inp.type = kind;
    inp.className = "ui-input";
    if (options.min !== undefined) inp.min = options.min;
    if (options.max !== undefined) inp.max = options.max;
    if (options.maxLength !== undefined) inp.maxLength = options.maxLength;
    control = inp;
  }

  attachSafeAttr(control, "data-ui", "input");
  if (options.id) control.id = options.id;
  if (options.name) control.name = options.name;
  if (options.placeholder && "placeholder" in control) control.placeholder = options.placeholder;
  if (options.ariaLabel) attachSafeAttr(control, "aria-label", options.ariaLabel);
  if (options.required) control.required = true;
  if (options.disabled) control.disabled = true;
  if (options.value !== undefined) control.value = options.value;

  if (options.onInput) {
    control.oninput = (event) => options.onInput?.(control.value, event);
  }
  if (options.onChange) {
    control.onchange = (event) => options.onChange?.(control.value, event);
  }

  wrapper.append(control);

  let hintNode: HTMLSpanElement | null = null;
  if (options.hint) {
    hintNode = document.createElement("span");
    hintNode.className = "ui-field-hint";
    hintNode.textContent = options.hint;
    wrapper.append(hintNode);
  }

  const errorNode = document.createElement("span");
  errorNode.className = "ui-field-error";
  errorNode.hidden = !options.error;
  if (options.error) {
    errorNode.textContent = options.error;
    attachSafeAttr(control, "aria-invalid", "true");
    attachSafeAttr(wrapper, "data-invalid", "true");
  }
  wrapper.append(errorNode);

  return {
    root: options.label || options.hint || options.error ? wrapper : control,
    control,
    getValue: () => control.value,
    setValue: (next: string) => {
      control.value = next;
    },
    setError: (message: string | null) => {
      const hasErr = Boolean(message);
      errorNode.textContent = message ?? "";
      errorNode.hidden = !hasErr;
      if (hasErr) {
        attachSafeAttr(control, "aria-invalid", "true");
        attachSafeAttr(wrapper, "data-invalid", "true");
      } else {
        control.removeAttribute?.("aria-invalid");
        wrapper.removeAttribute?.("data-invalid");
      }
      if (hintNode) hintNode.hidden = hasErr;
    },
  };
}

/**
 * Unified Card surface primitive (`data-ui="card"`).
 * Standardizes surface corner-radius, single-elevation shadow depth, and hover/press feel.
 */
export function createCard(options: UiCardOptions): HTMLElement {
  const variant = options.variant ?? "default";
  const padding = options.padding ?? "md";
  const card = document.createElement(options.tag ?? "article");
  card.className = joinClasses(
    "ui-card",
    `ui-card--${variant}`,
    `ui-card--pad-${padding}`,
    "panel-card",
    options.className,
  );
  attachSafeAttr(card, "data-ui", "card");
  attachSafeAttr(card, "data-variant", variant);

  if (options.eyebrow || options.title || options.subtitle || options.headerAction) {
    const head = document.createElement("div");
    head.className = "ui-card-head";

    const titles = document.createElement("div");
    titles.className = "ui-card-titles";
    if (options.eyebrow) {
      const eye = document.createElement("p");
      eye.className = "ui-card-eyebrow";
      eye.textContent = options.eyebrow;
      titles.append(eye);
    }
    if (options.title) {
      const heading = document.createElement("h3");
      heading.className = "ui-card-title";
      heading.textContent = options.title;
      titles.append(heading);
    }
    if (options.subtitle) {
      const sub = document.createElement("p");
      sub.className = "ui-card-subtitle";
      sub.textContent = options.subtitle;
      titles.append(sub);
    }
    head.append(titles);

    if (options.headerAction) {
      head.append(options.headerAction);
    }
    card.append(head);
  }

  if (options.body) {
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "ui-card-body";
    if (Array.isArray(options.body)) {
      bodyWrap.append(...options.body);
    } else {
      bodyWrap.append(options.body as HTMLElement);
    }
    card.append(bodyWrap);
  }

  if (options.footer) {
    const foot = document.createElement("div");
    foot.className = "ui-card-footer";
    if (Array.isArray(options.footer)) {
      foot.append(...options.footer);
    } else {
      foot.append(options.footer as HTMLElement);
    }
    card.append(foot);
  }

  if (options.onClick) {
    card.onclick = options.onClick;
    bindKeyboardPressFeedback(card);
  }

  return card;
}

/**
 * Unified 3-Zone Editorial Navbar primitive (`data-ui="navbar"`).
 * Builds a complete sticky header with Brand Seal + Breadcrumb, Segmented Tabs, and Actions.
 */
export function createNavbar(options: UiNavbarOptions): UiNavbarController {
  const header = document.createElement("header");
  header.className = "top ui-navbar";
  attachSafeAttr(header, "data-ui", "navbar");

  const left = document.createElement("div");
  left.className = "top-left";
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = options.brandHref ?? "./workbench";
  brand.textContent = options.brandLabel;
  if (options.onBrandClick) brand.onclick = options.onBrandClick;
  left.append(brand);

  const sep = document.createElement("span");
  sep.className = "top-sep";
  attachSafeAttr(sep, "aria-hidden", "true");
  sep.textContent = "/";

  const crumb = document.createElement("span");
  crumb.className = "breadcrumb";
  crumb.textContent = options.breadcrumb ?? "";
  left.append(sep, crumb);
  header.append(left);

  const tabButtons = new Map<string, HTMLButtonElement>();
  if (options.tabs && options.tabs.length > 0) {
    const nav = document.createElement("nav");
    nav.className = "top-center";
    attachSafeAttr(nav, "aria-label", "工作区视图控制");

    const segmented = document.createElement("div");
    segmented.className = "segmented workspace-views ui-navbar-tabs";
    attachSafeAttr(segmented, "role", "tablist");

    for (const tab of options.tabs) {
      const isActive = tab.id === options.activeTabId;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tab.label;
      btn.className = joinClasses("ui-navbar-tab", isActive && "active");
      attachSafeAttr(btn, "data-ui", "navbar-tab");
      attachSafeAttr(btn, "aria-selected", String(isActive));
      if (btn.dataset) btn.dataset.workspaceView = tab.id;
      btn.onclick = () => {
        setActiveTab(tab.id);
        options.onTabChange?.(tab.id);
      };
      bindKeyboardPressFeedback(btn);
      tabButtons.set(tab.id, btn);
      segmented.append(btn);
    }

    nav.append(segmented);
    header.append(nav);
  }

  const right = document.createElement("div");
  right.className = "top-actions";
  for (const action of options.actions ?? []) {
    right.append(action);
  }
  header.append(right);

  function setActiveTab(tabId: string): void {
    for (const [id, btn] of tabButtons.entries()) {
      const active = id === tabId;
      btn.className = joinClasses("ui-navbar-tab", active && "active");
      attachSafeAttr(btn, "aria-selected", String(active));
    }
  }

  function setBreadcrumb(text: string): void {
    crumb.textContent = text;
  }

  function setScrolled(scrolled: boolean): void {
    if (scrolled) attachSafeAttr(header, "data-scrolled", "true");
    else header.removeAttribute?.("data-scrolled");
  }

  return { root: header, setBreadcrumb, setActiveTab, setScrolled };
}

/**
 * Progressively enhances the static workbench `<header class="top">` shell with
 * unified Navbar elevation-on-scroll and keyboard tactile press states without
 * changing any existing DOM IDs.
 */
export function enhanceNavbar(header: HTMLElement | null): () => void {
  if (!header) return () => {};
  header.classList.add("ui-navbar");
  attachSafeAttr(header, "data-ui", "navbar");

  for (const tab of header.querySelectorAll<HTMLElement>(".workspace-views button")) {
    tab.classList.add("ui-navbar-tab");
    attachSafeAttr(tab, "data-ui", "navbar-tab");
    bindKeyboardPressFeedback(tab);
  }
  for (const btn of header.querySelectorAll<HTMLElement>(".top-actions button")) {
    btn.classList.add("ui-btn");
    attachSafeAttr(btn, "data-ui", "button");
    bindKeyboardPressFeedback(btn);
  }

  const syncScroll = () => {
    const scrolled = typeof window !== "undefined" && window.scrollY > 6;
    if (scrolled) attachSafeAttr(header, "data-scrolled", "true");
    else header.removeAttribute("data-scrolled");
  };

  syncScroll();
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("scroll", syncScroll, { passive: true });
    return () => window.removeEventListener("scroll", syncScroll);
  }
  return () => {};
}
