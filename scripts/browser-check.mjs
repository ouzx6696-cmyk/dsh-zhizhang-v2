import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import { openDatabase } from "../src/storage/index.ts";

const { chromium } = await import(process.env.ZHIZHANG_PLAYWRIGHT ?? "playwright");
const browser = await chromium.launch({
  executablePath: process.env.ZHIZHANG_CHROMIUM,
  args: process.env.ZHIZHANG_CHROMIUM ? ["--no-sandbox"] : [],
});
const db = openDatabase(":memory:");
const deliveries = [];
const app = openAuthorWorkspace(db, (_id, body) => deliveries.push(body));
const create = (product, name, title, mode = "short") => {
  const projectId = app.mutation("project.create", { product, name }).id;
  const documentId = app.mutation("document.create", { projectId, title, mode, line: "资讯线" }).id;
  return { projectId, documentId };
};
const novel = create("fanqie", "小说", "第一章");
const article = create("toutiao", "文章", "旧标题");
app.mutation("draft.save", { ...novel, baseRevisionId: null, body: "甲" });
app.mutation("draft.save", { ...article, baseRevisionId: null, body: "稿".repeat(1100) });
const page = await browser.newPage({ colorScheme: "dark", viewport: { width: 768, height: 1024 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
const ready = Promise.withResolvers();
const delivery = Promise.withResolvers();
let delay = true;

try {
  await page.route("http://workbench.test/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").at(-1);
    if (name === "state") {
      const result = app.snapshot(url.searchParams.get("projectId"), url.searchParams.get("documentId"));
      return route.fulfill({ json: { ok: true, result } });
    }
    if (name === "mutate") {
      const { action, ...input } = route.request().postDataJSON();
      try {
        const result = app.mutation(action, input);
        if (delay && action === "draft.save") {
          delay = false;
          ready.resolve();
          await delivery.promise;
        }
        return await route.fulfill({ json: { ok: true, result } });
      } catch (error) {
        return route.fulfill({ status: 409, json: { ok: false, code: error.code, details: error.details } });
      }
    }
    const file = name === "workbench" ? "workbench.html" : name;
    const types = { "workbench.html": "text/html", "workbench.js": "text/javascript", "workbench.css": "text/css" };
    const body = await readFile(new URL(`../src/client/${file}`, import.meta.url));
    return route.fulfill({ body, contentType: types[file] });
  });
  const open = async ({ projectId }) => {
    await page.locator("#projects").selectOption(projectId);
    await page.locator("#documents button").click();
    await page.locator("#body").waitFor();
  };
  const click = (id) => page.locator(`#${id}`).click();
  const expectText = (id, text) => page.locator(`#${id}`).getByText(text, { exact: true }).waitFor();
  await page.goto("http://workbench.test/workbench");
  await open(novel);
  const body = page.locator("#body");
  await body.fill("甲乙");
  await click("save");
  await ready.promise;
  await body.fill("甲乙丙");
  delivery.resolve();
  await expectText("notice", "已保存");
  assert.equal(await body.inputValue(), "甲乙丙");
  assert.equal(app.snapshot(novel.projectId, novel.documentId).active.body, "甲乙");
  await page.reload();
  await open(novel);
  assert.equal(await body.inputValue(), "甲乙丙");
  await click("save");
  await expectText("draft-status", "已保存");

  await page.locator("#continuity summary").click();
  await page.locator('#setting-proposal [name="factId"]').fill("f1");
  await page.locator('#setting-proposal [name="note"]').fill("设定");
  await page.locator('#setting-proposal [name="source"]').fill("作者笔记");
  await page.locator('#setting-proposal [name="character"]').fill("林");
  await page.locator("#setting-proposal button").click();
  await page.getByRole("button", { name: "确认设定" }).click();
  await page.locator('#settings-read [name="character"]').fill("林");
  await page.locator("#settings-read button").click();
  await page.getByText("设定 · 来源 作者笔记", { exact: false }).waitFor();
  await click("review-pass");
  await expectText("state", "已审稿");
  await click("finalize");
  await expectText("state", "已定稿");

  await open(article);
  await page.locator('#rename [name="title"]').fill("新标题");
  await page.locator("#rename button").click();
  await expectText("heading", "新标题");
  await page.locator('#qa [name="score"]').fill("84");
  await page.locator('#qa [name="passed"]').check();
  await page.locator("#qa button").click();
  await expectText("state", "待验收");
  await click("accept");
  await expectText("state", "已验收");
  await click("approve");
  await expectText("approve", "已批准交稿");
  await click("deliver");
  await expectText("export-status", "已写入交稿文件");
  assert.match(deliveries[0], /^# 新标题/u);
  assert.deepEqual(errors, []);
  console.log("通过保存与恢复、番茄设定到定稿、头条改题到交稿三条浏览器流程");
} finally {
  await browser.close();
  db.close();
}
