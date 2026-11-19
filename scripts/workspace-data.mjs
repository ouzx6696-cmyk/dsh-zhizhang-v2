import { backupWorkspace, restoreWorkspace } from "../src/storage/backup.ts";

const [operation, source, target] = process.argv.slice(2);
if (!source || !target || !["backup", "restore"].includes(operation)) {
  console.error("用法：先停止 DsH profile，再运行 node scripts/workspace-data.mjs backup|restore <来源目录> <全新目标目录>");
  process.exitCode = 1;
} else {
  try {
    await (operation === "backup" ? backupWorkspace : restoreWorkspace)(source, target);
    console.log(target);
  } catch (error) {
    console.error(error.code ?? error.name, error.details?.reason ?? "");
    process.exitCode = 1;
  }
}
