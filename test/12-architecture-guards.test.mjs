import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function extractImports(filePath) {
  const src = readFileSync(filePath, "utf8");
  const matches = [...src.matchAll(/(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g)];
  return matches.map((m) => m[1]);
}

test("domain/fanqie and domain/toutiao remain strictly isolated from each other and upper layers", () => {
  for (const file of listTsFiles(join(ROOT, "src", "domain", "fanqie"))) {
    for (const spec of extractImports(file)) {
      assert.doesNotMatch(spec, /toutiao|\/application\/|\/host\/|\/client\/|\/storage\//, `Leak in ${relative(ROOT, file)}: ${spec}`);
    }
  }
  for (const file of listTsFiles(join(ROOT, "src", "domain", "toutiao"))) {
    for (const spec of extractImports(file)) {
      assert.doesNotMatch(spec, /fanqie|\/application\/|\/host\/|\/client\/|\/storage\//, `Leak in ${relative(ROOT, file)}: ${spec}`);
    }
  }
});

test("storage layer never imports domain, application, host, or client", () => {
  for (const file of listTsFiles(join(ROOT, "src", "storage"))) {
    for (const spec of extractImports(file)) {
      assert.doesNotMatch(spec, /\/domain\/|\/application\/|\/host\/|\/client\//, `Storage layer leak in ${relative(ROOT, file)}: ${spec}`);
    }
  }
});

test("client layer never imports storage, host, application, or node:* built-ins", () => {
  for (const file of listTsFiles(join(ROOT, "src", "client"))) {
    for (const spec of extractImports(file)) {
      assert.doesNotMatch(spec, /^node:|\/storage\/|\/host\/|\/application\//, `Client layer leak in ${relative(ROOT, file)}: ${spec}`);
    }
  }
});

test("host/tools.ts and host/system-prompt.ts remain product-agnostic with zero hardcoded product names", () => {
  const toolsSrc = readFileSync(join(ROOT, "src", "host", "tools.ts"), "utf8");
  assert.doesNotMatch(toolsSrc, /zhizhang_read_tree|zhizhang_propose_setting|zhizhang_read_article/);
  const promptSrc = readFileSync(join(ROOT, "src", "host", "system-prompt.ts"), "utf8");
  assert.doesNotMatch(promptSrc, /fanqie|toutiao/i);
});

test("protected delivery ending lives only in canonical protected-rules.ts and its client mirror", () => {
  const ending = "——AI 到此止步。是否采用、何时发布由你决定。";
  const allowed = new Set([
    "src/contracts/protected-rules.ts",
    "src/client/contracts/protected-rules.ts",
  ]);
  for (const file of listTsFiles(join(ROOT, "src"))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    if (src.includes(ending)) {
      assert.ok(allowed.has(rel), `Protected delivery ending restated outside single definition site: ${rel}`);
    }
  }
});

test("package.json declares zero runtime dependencies and test/ contains only *.test.mjs files", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies ? Object.keys(pkg.dependencies).length : 0, 0);

  const testEntries = readdirSync(join(ROOT, "test"));
  assert.equal(testEntries.length, 14, `Expected exactly 14 test suites, found ${testEntries.length}`);
  for (const name of testEntries) {
    assert.ok(name.endsWith(".test.mjs"), `Non-test file in test/: ${name}`);
  }
});

test("WorkspaceAction maintains 100% parity with backend handlers and endpoint routes (zero phantom actions)", () => {
  const coreSrc = readFileSync(join(ROOT, "src", "contracts", "dto", "core.ts"), "utf8");
  const unionMatch = coreSrc.match(/export type WorkspaceAction =([\s\S]*?);/);
  assert.ok(unionMatch, "WorkspaceAction union missing in src/contracts/dto/core.ts");
  const unionActions = new Set([...unionMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const backendFiles = [
    ...listTsFiles(join(ROOT, "src", "application")),
    ...listTsFiles(join(ROOT, "src", "host")),
  ];
  const handled = new Set();
  for (const file of backendFiles) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:case\s+|action\s*===\s*|^\s*)"([a-z][a-z0-9_.]+\.[a-z0-9_.]+)"\s*:/gm)) {
      handled.add(m[1]);
    }
    for (const m of src.matchAll(/action\s*===\s*"([a-z][a-z0-9_.]+\.[a-z0-9_.]+)"/g)) {
      handled.add(m[1]);
    }
  }
  const endpointMapped = new Set([
    "read.model",
    "jobs.list",
    "run.preview",
    "run.generate",
    "proposal.generate",
    "selection.rewrite",
    "run.cancel",
    "proposal.cancel",
    "autopilot.start",
    "autopilot.resume",
    "material.extract",
    "autopilot.cancel",
  ]);

  const phantoms = [...unionActions].filter((a) => !handled.has(a) && !endpointMapped.has(a));
  const untyped = [...handled].filter((a) => !unionActions.has(a));
  assert.deepEqual(phantoms, [], `Phantom WorkspaceAction entries with no handler: ${phantoms.join(", ")}`);
  assert.deepEqual(untyped, [], `Handled actions missing from WorkspaceAction: ${untyped.join(", ")}`);
});

