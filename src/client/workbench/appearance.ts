export type PaperTheme = "auto" | "ink-paper" | "bamboo" | "night";
export type EditorFont = "serif" | "sans" | "kai";

export interface EditorTypographyPrefs {
  readonly font: EditorFont;
  readonly fontSize: 15 | 16 | 17 | 18;
  readonly measure: 720 | 820 | 960;
}

export const APPEARANCE_STORAGE_KEYS = {
  theme: "zhizhang:theme",
  typography: "zhizhang:typography",
} as const;

export const DEFAULT_TYPOGRAPHY: EditorTypographyPrefs = {
  font: "serif",
  fontSize: 16,
  measure: 820,
};

const FONT_STACKS: Readonly<Record<EditorFont, string>> = {
  serif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", Georgia, serif',
  sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "FangSong", "Source Han Serif SC", serif',
};

const THEME_LABELS: Readonly<Record<PaperTheme, string>> = {
  auto: "跟随宿主",
  "ink-paper": "墨纸",
  bamboo: "青简",
  night: "夜航",
};

export function normalizePaperTheme(raw: unknown): PaperTheme {
  if (raw === "ink-paper" || raw === "light") return "ink-paper";
  if (raw === "bamboo") return "bamboo";
  if (raw === "night" || raw === "dark") return "night";
  return "auto";
}

export function normalizeTypographyPrefs(raw: unknown): EditorTypographyPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_TYPOGRAPHY;
  const obj = raw as Record<string, unknown>;
  const font: EditorFont = obj.font === "sans" || obj.font === "kai" ? obj.font : "serif";
  const fontSize: 15 | 16 | 17 | 18 =
    obj.fontSize === 15 || obj.fontSize === 16 || obj.fontSize === 17 || obj.fontSize === 18
      ? obj.fontSize
      : 16;
  const measure: 720 | 820 | 960 =
    obj.measure === 720 || obj.measure === 820 || obj.measure === 960 ? obj.measure : 820;
  return { font, fontSize, measure };
}

export function applyAppearancePreferences(
  root: HTMLElement,
  theme: PaperTheme,
  typography: EditorTypographyPrefs,
  prefersDark = false,
): void {
  if (theme === "auto") {
    root.dataset.theme = prefersDark ? "night" : "ink-paper";
    root.dataset.themeMode = "auto";
  } else {
    root.dataset.theme = theme;
    root.dataset.themeMode = theme;
  }
  root.style.setProperty("--editor-font-family", FONT_STACKS[typography.font]);
  root.style.setProperty("--editor-font-size", `${typography.fontSize}px`);
  root.style.setProperty("--editor-measure", `${typography.measure}px`);
}

function readStoredTheme(): PaperTheme {
  try {
    return normalizePaperTheme(localStorage.getItem(APPEARANCE_STORAGE_KEYS.theme));
  } catch {
    return "auto";
  }
}

function readStoredTypography(): EditorTypographyPrefs {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEYS.typography);
    return raw ? normalizeTypographyPrefs(JSON.parse(raw)) : DEFAULT_TYPOGRAPHY;
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

function nodeContains(container: HTMLElement | null, target: unknown): boolean {
  if (!container || !target || typeof target !== "object") return false;
  if (container === target) return true;
  if (typeof container.contains === "function") {
    try {
      return container.contains(target as Node);
    } catch {
      // Fall back to parentElement walking for minimal fake DOM nodes.
    }
  }
  let cur = (target as { parentElement?: HTMLElement | null }).parentElement ?? null;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentElement ?? null;
  }
  return false;
}

function parseHostThemeMessage(data: unknown): "light" | "dark" | "auto" | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const payload = data as Record<string, unknown>;
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type !== "dsh:theme" && type !== "zhizhang:host-theme" && type !== "theme-change") {
    return null;
  }
  const raw = payload.theme ?? payload.colorScheme ?? payload.mode;
  if (raw === "dark" || raw === "night") return "dark";
  if (raw === "light" || raw === "ink-paper" || raw === "bamboo") return "light";
  if (raw === "auto" || raw === "system" || raw === null) return "auto";
  return null;
}

/**
 * Upgrades `#theme-toggle` into a 3-paper-theme + host-auto + reader-typography
 * control without inventing extra top-bar `#id` attributes.
 */
export function createAppearancePopover(button: HTMLButtonElement) {
  const root = document.documentElement;
  let theme: PaperTheme = readStoredTheme();
  let typography: EditorTypographyPrefs = readStoredTypography();
  let popover: HTMLElement | null = null;
  let hostThemeOverride: "light" | "dark" | null = null;

  const mql = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const isHostDark = () => (hostThemeOverride !== null ? hostThemeOverride === "dark" : (mql?.matches ?? false));

  function sync(): void {
    applyAppearancePreferences(root, theme, typography, isHostDark());
    button.textContent = `外观·${THEME_LABELS[theme]}`;
    button.setAttribute("aria-label", `切换纸面主题与正文排版（当前：${THEME_LABELS[theme]}）`);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEYS.theme, theme);
      localStorage.setItem(APPEARANCE_STORAGE_KEYS.typography, JSON.stringify(typography));
    } catch {
      // Ignore storage failures in sandboxed browsers.
    }
  }

  function closePopover(restoreFocus = false): void {
    if (!popover || popover.hidden) return;
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      button.focus?.();
    }
  }

  function paintPopover(): void {
    if (!popover) return;
    popover.replaceChildren();

    const makeGroup = <T extends string | number>(
      title: string,
      options: ReadonlyArray<readonly [T, string]>,
      activeValue: T,
      onPick: (val: T) => void,
      withSwatch = false,
    ) => {
      const wrap = document.createElement("div");
      wrap.className = "appearance-group";
      const label = document.createElement("span");
      label.className = "field-label";
      label.textContent = title;
      const row = document.createElement("div");
      row.className = "actions";
      for (const [val, text] of options) {
        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.textContent = text;
        if (withSwatch && optBtn.dataset) {
          optBtn.dataset.swatch = String(val);
        }
        if (val === activeValue) optBtn.className = "active";
        optBtn.onclick = (event?: MouseEvent) => {
          event?.stopPropagation?.();
          onPick(val);
          sync();
          paintPopover();
        };
        row.append(optBtn);
      }
      wrap.append(label, row);
      return wrap;
    };

    popover.append(
      makeGroup(
        "纸面主题（全局）",
        [["auto", "跟随宿主"], ["ink-paper", "墨纸"], ["bamboo", "青简"], ["night", "夜航"]],
        theme,
        (next) => {
          theme = next;
        },
        true,
      ),
      makeGroup(
        "正文字体（仅画布）",
        [["serif", "宋体"], ["sans", "黑体"], ["kai", "楷体"]],
        typography.font,
        (font) => {
          typography = { ...typography, font };
        },
      ),
      makeGroup(
        "正文字号",
        [[15, "15px"], [16, "16px"], [17, "17px"], [18, "18px"]],
        typography.fontSize,
        (fontSize) => {
          typography = { ...typography, fontSize };
        },
      ),
      makeGroup(
        "正文行宽",
        [[720, "720px"], [820, "820px"], [960, "960px"]],
        typography.measure,
        (measure) => {
          typography = { ...typography, measure };
        },
      ),
    );
  }

  const onMediaChange = () => {
    if (theme === "auto") sync();
  };
  if (typeof mql?.addEventListener === "function") {
    mql.addEventListener("change", onMediaChange);
  } else if (typeof (mql as { addListener?: (fn: () => void) => void } | null)?.addListener === "function") {
    (mql as { addListener: (fn: () => void) => void }).addListener(onMediaChange);
  }

  const onHostMessage = (event: MessageEvent) => {
    if (
      typeof location !== "undefined" &&
      typeof location.origin === "string" &&
      location.origin &&
      location.origin !== "null" &&
      event.origin &&
      event.origin !== location.origin
    ) {
      return;
    }
    const parsed = parseHostThemeMessage(event.data);
    if (!parsed) return;
    hostThemeOverride = parsed === "auto" ? null : parsed;
    if (theme === "auto") sync();
  };
  window.addEventListener?.("message", onHostMessage);

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && popover && !popover.hidden) {
      event.preventDefault?.();
      closePopover(true);
    }
  };
  document.addEventListener?.("keydown", onDocumentKeyDown);

  const onDocumentClick = (event: Event) => {
    if (!popover || popover.hidden) return;
    const target = event.target;
    const composed = typeof event.composedPath === "function" ? event.composedPath() : null;
    if (composed && (composed.includes(popover) || composed.includes(button))) return;
    if (nodeContains(popover, target) || nodeContains(button, target)) return;
    closePopover(true);
  };
  document.addEventListener?.("click", onDocumentClick);

  sync();

  button.setAttribute("aria-expanded", "false");
  button.onclick = () => {
    if (!popover) {
      popover = document.createElement("div");
      popover.className = "appearance-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", "纸面主题与正文排版");
      popover.hidden = true;
      popover.addEventListener?.("click", (event) => event.stopPropagation?.());
      (button.parentElement ?? document.body).append(popover);
    }
    const willOpen = popover.hidden;
    if (willOpen) {
      paintPopover();
      popover.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const activeBtn = popover.querySelector<HTMLButtonElement>("button.active") ?? popover.querySelector<HTMLButtonElement>("button");
      activeBtn?.focus?.();
    } else {
      closePopover(true);
    }
  };

  function destroy(): void {
    if (typeof mql?.removeEventListener === "function") {
      mql.removeEventListener("change", onMediaChange);
    } else if (typeof (mql as { removeListener?: (fn: () => void) => void } | null)?.removeListener === "function") {
      (mql as { removeListener: (fn: () => void) => void }).removeListener(onMediaChange);
    }
    window.removeEventListener?.("message", onHostMessage);
    document.removeEventListener?.("keydown", onDocumentKeyDown);
    document.removeEventListener?.("click", onDocumentClick);
    popover?.remove?.();
    popover = null;
  }

  return { sync, close: closePopover, destroy };
}
