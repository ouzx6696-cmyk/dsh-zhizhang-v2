#!/usr/bin/env node
import { existsSync } from "node:fs";

const sourceModule = new URL("../src/storage/backup.ts", import.meta.url);
const { backupWorkspace, restoreWorkspace } = await import(existsSync(sourceModule)
  ? sourceModule.href
  : new URL("../dist/server/storage/backup.js", import.meta.url).href);

const [operation, source, target] = process.argv.slice(2);
if (!source || !target || !["backup", "restore"].includes(operation)) {
  console.error("用法：先停止 DsH profile，再运行 node scripts/workspace-data.mjs backup|restore <来源目录> <全新目标目录>");
  process.exitCode = 1;
} else {
  try {
    if (operation === "backup") {
      await backupWorkspace(source, target, { includeExports: true });
    } else {
      await restoreWorkspace(source, target);
    }
    console.log(target);
  } catch (error) {
    console.error(error.code ?? error.name, error.details?.reason ?? "");
    process.exitCode = 1;
  }
}
