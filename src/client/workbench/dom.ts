export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workbench element #${id}`);
  return node as T;
}

export interface ElementOptions {
  readonly text?: string;
  readonly className?: string;
}

/**
 * Unified DOM element factory supporting both `(tag, text, className)` and
 * `(tag, { text, className })` call styles across all workbench views.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  textOrOptions: string | ElementOptions = "",
  className?: string,
): HTMLElementTagNameMap[K] {
  const entry = document.createElement(tag);
  if (typeof textOrOptions === "string") {
    if (textOrOptions) entry.textContent = textOrOptions;
    if (className) entry.className = className;
  } else {
    if (textOrOptions.className) entry.className = textOrOptions.className;
    if (textOrOptions.text !== undefined) entry.textContent = textOrOptions.text;
  }
  return entry;
}
