import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";

/**
 * Refreshes `mtime` across built `dist/client/` assets and static client
 * HTML/CSS files so DsH's `artifactRevision` cache never treats `npm pack`
 * 1985-10-26 timestamps as immutable stale artifacts.
 *
 * Strictly local & workspace-only: never accesses or modifies any DsH profile.
 */
const MIN_FRESH_EPOCH_MS = Date.parse("2020-01-01T00:00:00.000Z");

export function touchBuildArtifacts(rootDir = fileURLToPath(new URL("..", import.meta.url)), now = new Date()) {
  const serverEntry = join(rootDir, "dist", "server", "host", "plugin.js");
  const clientSlot = join(rootDir, "dist", "client", "slot.js");
  const clientDistRoot = join(rootDir, "dist", "client");
  assert.equal(existsSync(serverEntry), true, `Missing server entrypoint: ${serverEntry}. Run npm run build first.`);
  assert.equal(existsSync(clientSlot), true, `Missing client slot entrypoint: ${clientSlot}. Run npm run build first.`);
  assert.equal(existsSync(clientDistRoot), true, `Missing dist/client directory: ${clientDistRoot}`);

  const touched = [];

  function walkAndTouch(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndTouch(full);
      } else if (entry.isFile()) {
        utimesSync(full, now, now);
        assert.ok(statSync(full).mtimeMs > MIN_FRESH_EPOCH_MS, `Stale mtime after touch: ${full}`);
        touched.push(full);
      }
    }
  }

  walkAndTouch(clientDistRoot);

  for (const mod of CLIENT_JS_MODULES) {
    const builtMod = join(rootDir, "dist", "client", ...mod.split("/"));
    assert.equal(existsSync(builtMod), true, `Missing built client module: ${builtMod}`);
  }

  for (const staticAsset of [
    join(rootDir, "src", "client", CLIENT_ENTRY_HTML),
    join(rootDir, "src", "client", CLIENT_ENTRY_CSS),
  ]) {
    assert.equal(existsSync(staticAsset), true, `Missing static client asset: ${staticAsset}`);
    utimesSync(staticAsset, now, now);
    assert.ok(statSync(staticAsset).mtimeMs > MIN_FRESH_EPOCH_MS, `Stale mtime after touch: ${staticAsset}`);
    touched.push(staticAsset);
  }

  return {
    serverEntry,
    clientSlot,
    touchedCount: touched.length,
    minMtimeMs: MIN_FRESH_EPOCH_MS,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain || process.argv.includes("--touch-only")) {
  const summary = touchBuildArtifacts();
  console.log(`[deploy] mtime refreshed on ${summary.touchedCount} client artifacts (server=${summary.serverEntry})`);
}
