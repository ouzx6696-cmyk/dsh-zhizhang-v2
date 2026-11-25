import { readFileSync, writeFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const entry = new URL("../src/client/slot.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(entry, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 },
});
const script = `(function (exports) {\n${outputText}\n})({});\n`;
new Script(script, { filename: "dsh.js" });
writeFileSync(new URL("../dist/client/dsh.js", import.meta.url), script);
