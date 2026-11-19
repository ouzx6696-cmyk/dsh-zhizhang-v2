// Single source of truth for static browser workbench assets served by the
// DsH host plugin, local preview server, and Playwright verification script.

export const CLIENT_ENTRY_HTML = "workbench.html" as const;
export const CLIENT_ENTRY_CSS = "workbench.css" as const;

export const CLIENT_JS_MODULES = [
  "workbench/main.js",
  "workbench/shell.js",
  "workbench/diff.js",
  "workbench/api.js",
  "workbench/draft-vault.js",
  "workbench/modal.js",
  "workbench/plugins/fanqie.js",
  "workbench/plugins/toutiao.js",
  "workbench/views/diff-view.js",
  "workbench/views/run-inspector.js",
] as const;
