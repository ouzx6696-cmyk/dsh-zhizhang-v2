import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
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
const secondChapter = app.mutation("document.create", { projectId: novel.projectId, title: "第二章" }).id;
const article = create("toutiao", "文章", "旧标题");
app.mutation("draft.save", { ...novel, baseRevisionId: null, body: "甲" });
app.mutation("draft.save", { documentId: secondChapter, baseRevisionId: null, body: "信" });
app.mutation("chapter.outline", {
  documentId: secondChapter, viewpoint: "林", target: 2200, lockedFacts: "信", knowledge: "见人物设定",
  剧情梗概: "林收到信", 核心冲突与看点: "是否拆开", 情节推进节点: "第三段读信", 章末落点: "留下疑问",
});
app.mutation("draft.save", { ...article, baseRevisionId: null, body: "稿".repeat(1100) });
const browserContext = await browser.newContext({ colorScheme: "dark", viewport: { width: 1024, height: 900 } });
const page = await browserContext.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = Promise.withResolvers();
const delivery = Promise.withResolvers();
let delay = true;
let refresh;

const STATIC_ASSETS = new Map([
  ["/workbench", { file: `../src/client/${CLIENT_ENTRY_HTML}`, type: "text/html" }],
  ["/workbench.css", { file: `../src/client/${CLIENT_ENTRY_CSS}`, type: "text/css" }],
  ...CLIENT_JS_MODULES.map((modulePath) => [
    `/${modulePath}`,
    { file: `../dist/client/${modulePath}`, type: "text/javascript" },
  ]),
]);

try {
  await browserContext.route("http://workbench.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/state") {
      const result = app.readState(
        url.searchParams.get("projectId") ?? undefined,
        url.searchParams.get("documentId") ?? undefined,
        url.searchParams.get("ifSequence") ?? undefined,
      );
      if (refresh) {
        const { ready, release } = refresh;
        refresh = null;
        ready.resolve();
        await release.promise;
      }
      return route.fulfill({ json: { ok: true, result } });
    }
    if (url.pathname === "/mutate") {
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
    const asset = STATIC_ASSETS.get(url.pathname);
    if (!asset) return route.fulfill({ status: 404, body: "Not found" });
    const body = await readFile(new URL(asset.file, import.meta.url));
    return route.fulfill({ body, contentType: asset.type });
  });

  const open = async ({ projectId }, title, tab = page) => {
    await tab.locator("#projects").selectOption(projectId);
    await tab.locator("#documents button").filter({ hasText: title }).click();
    await tab.locator("#body").waitFor();
  };
  const click = (id) => page.locator(`#${id}`).click();
  const selectTab = (name) => page.locator(`[data-pipeline-tab="${name}"]`).click();
  const confirmModal = () => page.locator("#workbench-dialog button.primary").click();
  const expectText = (id, text) => page.locator(`#${id}`).getByText(text, { exact: true }).waitFor();

  await page.goto("http://workbench.test/workbench");
  await open(novel, "第一章");
  const body = page.locator("#body");
  await body.fill("甲乙");
  await click("save");
  await ready.promise;
  await body.fill("甲乙丙");
  delivery.resolve();
  await expectText("notice-text", "已保存");
  assert.equal(await body.inputValue(), "甲乙丙");
  assert.equal(app.snapshot(novel.projectId, novel.documentId).active.body, "甲乙");
  await page.reload();
  await open(novel, "第一章");
  assert.equal(await body.inputValue(), "甲乙丙");

  const refreshAfterSave = { ready: Promise.withResolvers(), release: Promise.withResolvers() };
  refresh = refreshAfterSave;
  await click("save");
  await refreshAfterSave.ready.promise;
  await body.fill("甲乙丙丁");
  refreshAfterSave.release.resolve();
  await expectText("notice-text", "已保存");
  assert.equal(await body.inputValue(), "甲乙丙丁");
  assert.equal(app.snapshot(novel.projectId, novel.documentId).active.body, "甲乙丙");
  await page.reload();
  await open(novel, "第一章");
  assert.equal(await body.inputValue(), "甲乙丙丁");
  await click("save");
  await expectText("draft-status", "已保存");

  const secondTab = await browserContext.newPage();
  await secondTab.goto(page.url());
  await open(novel, "第一章", secondTab);
  await secondTab.locator("#body").fill("第二页保留的稿件");
  await secondTab.locator("#body").blur();
  await body.fill("甲乙丙丁戊");
  await click("save");
  await expectText("notice-text", "已保存");
  await secondTab.reload();
  await open(novel, "第一章", secondTab);
  assert.equal(await secondTab.locator("#body").inputValue(), "第二页保留的稿件");
  await secondTab.getByText("有一份基于旧版本的本地编辑。").waitFor();
  await secondTab.close();
  await page.bringToFront();

  await selectTab("continuity");
  await page.locator('#setting-proposal [name="factId"]').fill("f1");
  await page.locator('#setting-proposal [name="note"]').fill("设定");
  await page.locator('#setting-proposal [name="source"]').fill("作者笔记");
  await click("setting-add-person");
  await page.locator("#setting-people [data-person]").fill("乔");
  await click("setting-add-person");
  const later = page.locator("#setting-people fieldset").last();
  await later.locator("[data-person]").fill("林");
  await later.locator("[data-when]").selectOption(secondChapter);
  await later.locator("[data-point]").fill("3");
  await page.locator('#setting-proposal [name="toChapter"]').selectOption(secondChapter);
  await page.locator('#setting-proposal [name="toPoint"]').fill("4");
  await page.locator("#setting-proposal button[type=submit]").click();
  await page.getByRole("button", { name: "确认设定" }).click();
  await page.locator('#settings-read [name="character"]').fill("乔");
  await page.locator("#settings-read button").click();
  await page.getByText("设定 · 来源 作者笔记", { exact: false }).waitFor();

  await selectTab("workflow");
  await click("review-pass");
  await expectText("state", "已审稿");
  await click("finalize");
  await confirmModal();
  await expectText("state", "已定稿");

  await page.locator("#documents button").filter({ hasText: "第二章" }).click();
  await expectText("heading", "第二章");
  await selectTab("continuity");
  await page.locator('#settings-read [name="character"]').fill("林");
  await page.locator('#settings-read [name="point"]').fill("2");
  await page.locator("#settings-read button").click();
  await expectText("known-settings", "此时该人物没有已确认的知情设定。");
  await page.locator('#settings-read [name="point"]').fill("3");
  await page.locator("#settings-read button").click();
  await page.getByText("设定 · 来源 作者笔记", { exact: false }).waitFor();

  await selectTab("runs");
  await page.locator('#start-run [name="instruction"]').fill("接写");
  await page.locator('#start-run [name="point"]').fill("3");
  await click("estimate-budget");
  await page.getByText("首轮写作预留约", { exact: false }).waitFor();
  await page.locator("#start-run button[type=submit]").click();
  await expectText("run-status", "等待候选稿");
  const run = app.mutation("run.history", { documentId: secondChapter })[0];
  const { frozenInput } = app.mutation("run.detail", { documentId: secondChapter, runId: run.id });
  assert.equal(JSON.parse(frozenInput).knownFacts[0].id, "f1");
  await selectTab("continuity");
  await page.locator('#settings-read [name="point"]').fill("4");
  await page.locator("#settings-read button").click();
  await expectText("known-settings", "此时该人物没有已确认的知情设定。");

  await open(article, "旧标题");
  await page.locator('#rename [name="title"]').fill("新标题");
  await page.locator("#rename button").click();
  await expectText("heading", "新标题");
  await selectTab("workflow");
  await page.locator('#qa [name="score"]').fill("84");
  await page.locator('#qa [name="passed"]').check();
  await page.locator("#qa button").click();
  await expectText("state", "待验收");
  await click("accept");
  await expectText("state", "已验收");
  await click("approve");
  await confirmModal();
  await expectText("approve", "已批准交稿");
  await click("deliver");
  await expectText("export-status", "已写入交稿文件");
  assert.match(deliveries[0], /^# 新标题/u);

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 900 },
    { width: 768, height: 900 },
  ]) {
    await page.setViewportSize(vp);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `Horizontal overflow ${overflow}px at viewport ${vp.width}x${vp.height}`);
  }

  assert.deepEqual(errors, []);
  console.log("通过保存与恢复、番茄设定到定稿、头条改题到交稿与 4 视口几何验收");
} finally {
  await browser.close();
  db.close();
}
