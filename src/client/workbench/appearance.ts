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

/**
 * Upgrades `#theme-toggle` into a 3-paper-theme + host-auto + reader-typography
 * control without inventing extra top-bar `#id` attributes.
 */
export function createAppearancePopover(button: HTMLButtonElement) {
  const root = document.documentElement;
  let theme: PaperTheme = readStoredTheme();
  let typography: EditorTypographyPrefs = readStoredTypography();
  let popover: HTMLElement | null = null;

  const isHostDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

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

  function closePopover(): void {
    if (popover) {
      popover.hidden = true;
      button.setAttribute("aria-expanded", "false");
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
        if (val === activeValue) optBtn.className = "active";
        optBtn.onclick = () => {
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

  sync();

  button.setAttribute("aria-expanded", "false");
  button.onclick = () => {
    if (!popover) {
      popover = document.createElement("div");
      popover.className = "appearance-popover";
      popover.hidden = true;
      (button.parentElement ?? document.body).append(popover);
    }
    const willOpen = popover.hidden;
    if (willOpen) {
      paintPopover();
      popover.hidden = false;
      button.setAttribute("aria-expanded", "true");
    } else {
      closePopover();
    }
  };

  return { sync, close: closePopover };
}
