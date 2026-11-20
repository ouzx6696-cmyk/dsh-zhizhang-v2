// Single source of truth for static browser workbench assets served by the
// DsH host plugin, local preview server, and Playwright verification script.

export const CLIENT_ENTRY_HTML = "workbench.html" as const;
export const CLIENT_ENTRY_CSS = "workbench.css" as const;

export const CLIENT_JS_MODULES = [
  "workbench/main.js",
  "workbench/shell.js",
  "workbench/store.js",
  "workbench/diff.js",
  "workbench/api.js",
  "workbench/draft-vault.js",
  "workbench/modal.js",
  "workbench/plugins/fanqie.js",
  "workbench/plugins/toutiao.js",
  "workbench/views/diff-view.js",
  "workbench/views/run-inspector.js",
  "workbench/views/virtual-list.js",
  "workbench/views/tree-sidebar.js",
  "workbench/views/command-palette.js",
  "workbench/views/context-preview.js",
  "workbench/views/outline-board.js",
  "workbench/views/worldbook-view.js",
  "workbench/views/library-view.js",
  "workbench/views/io-view.js",
] as const;
