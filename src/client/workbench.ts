import { WorkbenchStore, type ThemePreference } from "./app/store.ts";
import { createDirectoryView } from "./app/views/directory.ts";
import { createEditorView } from "./app/views/editor.ts";
import { createPipelineView } from "./app/views/pipeline.ts";

const THEME_STORAGE_KEY = "zhizhang:theme";

function initThemeToggle(): void {
  const button = document.getElementById("theme-toggle") as HTMLButtonElement | null;
  const root = document.documentElement;
  const order: readonly ThemePreference[] = ["system", "light", "dark"];
  const labels: Readonly<Record<ThemePreference, string>> = {
    system: "跟随系统",
    light: "纸面浅色",
    dark: "墨石深色",
  };

  let current: ThemePreference = "system";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") current = saved;
  } catch {
    // Ignore storage restrictions.
  }

  function applyTheme(pref: ThemePreference): void {
    current = pref;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    if (button) button.textContent = labels[pref];
    try {
      localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      // Ignore storage restrictions.
    }
  }

  applyTheme(current);
  if (button) {
    button.onclick = () => {
      const next = order[(order.indexOf(current) + 1) % order.length];
      applyTheme(next);
    };
  }
}

function initRegionToggles(): void {
  const layout = document.getElementById("layout");
  if (!layout) return;
  for (const region of ["navigation", "pipeline"] as const) {
    const button = document.getElementById(`${region}-toggle`);
    const panel = document.getElementById(region);
    if (!button || !panel) continue;
    button.onclick = () => {
      const scrollBox = document.scrollingElement;
      const span = scrollBox ? scrollBox.scrollHeight - scrollBox.clientHeight : 0;
      const ratio = scrollBox && span > 0 ? scrollBox.scrollTop / span : 0;
      panel.hidden = !panel.hidden;
      layout.classList.toggle(`without-${region}`, panel.hidden);
      button.setAttribute("aria-pressed", String(!panel.hidden));
      if (scrollBox) {
        requestAnimationFrame(() => {
          scrollBox.scrollTop = ratio * (scrollBox.scrollHeight - scrollBox.clientHeight);
        });
      }
    };
  }
}

function renderNotice(store: WorkbenchStore): void {
  const banner = document.getElementById("notice");
  if (!banner) return;
  const { message, isError, diagnosticId } = store.noticeState;
  banner.hidden = !message;
  banner.setAttribute("role", isError ? "alert" : "status");
  banner.dataset.tone = isError ? "error" : "info";
  if (!message) {
    banner.replaceChildren();
    return;
  }
  const textNode = document.createElement("span");
  textNode.textContent = message;
  const parts: (HTMLElement | string)[] = [textNode];
  if (diagnosticId) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "notice-copy";
    copyBtn.textContent = "复制诊断号";
    copyBtn.onclick = () => {
      void navigator.clipboard?.writeText(diagnosticId);
      copyBtn.textContent = "已复制";
    };
    parts.push(copyBtn);
  }
  banner.replaceChildren(...parts);
}

const store = new WorkbenchStore();
const pipeline = createPipelineView(store);
const directory = createDirectoryView(store, (titles) => pipeline.onDirectoryChanged(titles));
const editor = createEditorView(store);

store.subscribe(() => {
  renderNotice(store);
  directory.render();
  editor.render();
  pipeline.render();
});

initThemeToggle();
initRegionToggles();
void store.perform(() => store.load());
