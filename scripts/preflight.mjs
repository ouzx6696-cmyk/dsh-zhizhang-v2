import { readFileSync } from "node:fs";

const MIN_NODE = [24, 9, 0];

function parseVersion(raw) {
  return raw.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function meetsMinVersion(actual, min) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > min[i]) return true;
    if (actual[i] < min[i]) return false;
  }
  return true;
}

const failures = [];
const nodeVersion = parseVersion(process.versions.node);
if (!meetsMinVersion(nodeVersion, MIN_NODE)) {
  failures.push(`Node.js >= ${MIN_NODE.join(".")} required, found ${process.versions.node}`);
}

try {
  const sqlite = await import("node:sqlite");
  if (typeof sqlite.DatabaseSync !== "function" || typeof sqlite.backup !== "function") {
    failures.push("node:sqlite DatabaseSync or backup export missing");
  }
} catch (error) {
  failures.push(`node:sqlite failed to load: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
  if (deps.length > 0) {
    failures.push(`Zero runtime dependencies required, found: ${deps.join(", ")}`);
  }
} catch (error) {
  failures.push(`Failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  for (const issue of failures) console.error(`[preflight] FAIL: ${issue}`);
  process.exit(1);
}

console.log(`[preflight] OK (Node ${process.versions.node}, node:sqlite ready, zero runtime dependencies)`);
