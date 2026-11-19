const byId = (id) => document.getElementById(id);
const editor = byId("body");
const stages = { planned: "待写", drafting: "写作中", drafted: "已有草稿", reviewed: "已审稿", final: "已定稿" };
const fields = (form) => Object.fromEntries(new FormData(form));
let snapshot = {};
let projectId = "";
let documentId = "";
let loading = false;
let deliveryUrl;
let poll;
let planDocument;

function notice(message, isError = false) {
  const output = byId("notice");
  output.textContent = message;
  output.hidden = !message;
  output.setAttribute("role", isError ? "alert" : "status");
}

async function request(action, input, ifSequence) {
  const url = new URL(action ? "./mutate" : "./state", location.href);
  if (projectId) url.searchParams.set("projectId", projectId);
  if (documentId) url.searchParams.set("documentId", documentId);
  if (ifSequence !== undefined) url.searchParams.set("ifSequence", String(ifSequence));
  const options = action ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }),
  } : {};
  const response = await fetch(url, options);
  if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error("请从 DsH 已登录页面打开织章。");
  const packet = await response.json();
  if (!packet.ok) {
    const fields = packet.details ?? {};
    const reason = fields.reason ?? fields.field;
    const message = packet.code === "version.conflict" ? "稿件版本已更新。本地编辑已保留，请刷新后核对再保存。" : [packet.code, reason].filter(Boolean).join(" · ");
    throw new Error(message);
  }
  return packet.result;
}

function stashKey(id) { return `zhizhang:draft:${id}`; }
function readStash(id) {
  const value = localStorage.getItem(stashKey(id));
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
function stash() {
  const active = snapshot.active;
  if (!active) return;
  if (editor.value === (active.body ?? "")) localStorage.removeItem(stashKey(active.id));
  else localStorage.setItem(stashKey(active.id), JSON.stringify({ body: editor.value, revisionId: active.revisionId }));
}
function element(tag, label) {
  const entry = document.createElement(tag);
  entry.textContent = label;
  return entry;
}
function candidate() { return snapshot.runs?.find((run) => run.state === "awaiting-author"); }
function currentRun() { return snapshot.runs?.find((run) => run.state === "running"); }

function render() {
  const projects = byId("projects");
  const navigation = byId("documents");
  const project = snapshot.projects?.find((item) => item.id === projectId);
  const active = snapshot.active;
  const article = project?.product === "toutiao";
  const hasDraft = Boolean(active?.revisionId);
  const locked = ["final", "已验收", "已交稿"].includes(active?.state);
  projects.replaceChildren(element("option", "选择项目"));
  projects.firstChild.value = "";
  for (const item of snapshot.projects ?? []) {
    const choice = element("option", item.name);
    choice.value = item.id;
    projects.append(choice);
  }
  projects.value = projectId;
  navigation.replaceChildren();
  for (const item of snapshot.documents ?? []) {
    const button = element("button", item.title || "微头条");
    button.setAttribute("aria-current", String(item.id === documentId));
    button.onclick = () => perform(async () => {
      stash();
      byId("known-settings").replaceChildren();
      documentId = item.id;
      await load();
    });
    navigation.append(button);
  }
  byId("document-tools").hidden = !project;
  byId("article-options").hidden = !article;
  byId("empty").hidden = Boolean(active);
  byId("manuscript").hidden = !active;
  byId("flow-empty").hidden = Boolean(active);
  byId("flow-content").hidden = !active;
  if (!active) return;

  byId("document-label").textContent = article ? "头条创作" : "番茄连载";
  byId("heading").textContent = active.title || "微头条";
  byId("state").textContent = stages[active.state] ?? active.state;
  const saved = readStash(active.id);
  const stale = saved && saved.revisionId !== active.revisionId;
  editor.value = saved?.body ?? active.body ?? "";
  editor.readOnly = locked;
  byId("save").disabled = locked;
  const draftStatus = byId("draft-status");
  draftStatus.replaceChildren(document.createTextNode(stale ? "有一份基于旧版本的本地编辑。" : saved ? "已恢复本地编辑" : hasDraft ? "已保存" : "尚未保存"));
  if (stale) {
    byId("save").disabled = true;
    const restore = element("button", "使用服务器版本");
    restore.onclick = () => {
      if (!window.confirm("丢弃这份基于旧版本的本地编辑？")) return;
      localStorage.removeItem(stashKey(active.id));
      render();
    };
    draftStatus.append(" ", restore);
  }
  byId("chapter-outline").hidden = article;
  byId("article-plan").hidden = !article;
  if (planDocument !== active.id) {
    planDocument = active.id;
    const outline = byId("chapter-outline");
    const articlePlan = byId("article-plan");
    outline.reset();
    articlePlan.reset();
    const plan = snapshot.planning ?? {};
    for (const [key, value] of Object.entries({ ...plan, ...plan.sections })) {
      if (outline.elements[key] && (typeof value === "string" || typeof value === "number")) {
        outline.elements[key].value = value;
      }
    }
    if (snapshot.scenario) {
      for (const [name, key] of [["driver", "drivers"], ["opening", "openings"], ["ending", "endings"]]) {
        articlePlan.elements[name].replaceChildren(...snapshot.scenario[key].map((word) => element("option", word)));
        if (plan[name]) articlePlan.elements[name].value = plan[name];
      }
      byId("title-matrix").hidden = !snapshot.scenario.hasTitle;
      articlePlan.elements.titles.value = plan.titleMatrix?.valid.map(({ text, motif }) => `${text} | ${motif}`).join("\n") ?? "";
    }
  }
  byId("fanqie-actions").hidden = article;
  byId("continuity").hidden = article;
  const settingList = byId("settings");
  settingList.replaceChildren();
  for (const entry of snapshot.settings ?? []) {
    const row = element("section", "");
    row.append(element("p", `${entry.fact.id} · ${entry.fact.note} · ${({ approved: "已确认", rejected: "已拒绝", pending: "待确认" })[entry.decision]}`));
    if (entry.decision === "pending") {
      for (const [label, accept] of [["确认设定", true], ["拒绝提案", false]]) {
        const button = element("button", label);
        button.onclick = () => perform(() => change("setting.decide", { projectId, proposalId: entry.id, accept }));
        row.append(button);
      }
    }
    settingList.append(row);
  }
  const position = snapshot.documents.findIndex(({ id }) => id === active.id);
  byId("move-up").disabled = position < 1;
  byId("move-down").disabled = position >= snapshot.documents.length - 1;
  byId("toutiao-actions").hidden = !article;
  byId("reviews").textContent = `审稿打回 ${active.editorialRejections} / 2 次`;
  byId("review-pass").disabled = !hasDraft || locked || active.state === "reviewed";
  byId("review-reject").disabled = !hasDraft || locked || active.editorialRejections >= 2;
  byId("finalize").disabled = active.state !== "reviewed";

  byId("qa").querySelector("button").disabled = !hasDraft || locked;
  byId("refine").disabled = !hasDraft || active.state !== "初稿待改" || active.qaRounds >= 2;
  byId("accept").disabled = byId("reject").disabled = active.state !== "待验收";
  byId("approve").disabled = active.state !== "已验收" || snapshot.approved;
  byId("approve").textContent = snapshot.approved ? "已批准交稿" : "批准交稿";
  byId("deliver").disabled = !snapshot.approved || !["已验收", "已交稿"].includes(active.state);
  byId("deliver").textContent = active.state === "已交稿" ? "重试或检查导出" : "交稿";
  const download = byId("download");
  if (deliveryUrl) URL.revokeObjectURL(deliveryUrl);
  deliveryUrl = snapshot.delivery ? URL.createObjectURL(new Blob([snapshot.delivery], { type: "text/markdown;charset=utf-8" })) : undefined;
  download.hidden = !deliveryUrl;
  if (deliveryUrl) download.href = deliveryUrl;

  const pending = candidate();
  const run = currentRun() ?? snapshot.runs?.[0];
  byId("comparison").hidden = !pending || locked;
  byId("candidate").value = pending?.candidateBody ?? "";
  const candidateQa = pending?.candidateQa ? JSON.parse(pending.candidateQa) : undefined;
  byId("candidate-qa").hidden = !candidateQa;
  byId("candidate-qa").textContent = candidateQa
    ? [`候选稿质检 ${candidateQa.overall} 分 · 回改 ${pending.refinementRounds} 轮`, ...candidateQa.fails, ...candidateQa.hardGates].join(" · ") : "";
  byId("automatic-qa").hidden = !article;
  byId("adopt").disabled = pending?.baseRevisionId !== active.revisionId;
  byId("run-content").hidden = !run;
  byId("start-run").querySelector("button").disabled = !hasDraft || locked || Boolean(currentRun());
  byId("run-status").textContent = run ? ({ running: "等待候选稿", "awaiting-author": "等待作者决定", applied: "已采纳", discarded: "已舍弃", failed: "任务失败", cancelled: "已取消" })[run.state] ?? run.state : "";
  byId("run-input").textContent = run ? JSON.stringify(JSON.parse(run.frozenInput), null, 2) : "";
  byId("complete-run").hidden = run?.state !== "running";
  byId("generate-run").hidden = !["running", "failed"].includes(run?.state);
  if (poll && run?.state !== "running") {
    clearInterval(poll);
    poll = undefined;
  }
  byId("cancel").hidden = run?.state !== "running";
}

async function load(ifSequence) {
  const next = await request(undefined, undefined, ifSequence);
  if (next.unchanged) return;
  if (poll && next.active?.id !== snapshot.active?.id) {
    clearInterval(poll);
    poll = undefined;
  }
  snapshot = next;
  render();
}
async function perform(work) {
  if (loading) return;
  loading = true;
  notice("");
  try { await work(); }
  catch (error) { notice(error.message, true); }
  finally { loading = false; }
}
function form(id, submit) {
  byId(id).onsubmit = (event) => {
    event.preventDefault();
    void perform(() => submit(fields(event.currentTarget), event.currentTarget));
  };
}
function click(id, handler) {
  byId(id).onclick = () => perform(handler);
}
function activeInput(extra) {
  return { documentId, baseRevisionId: snapshot.active?.revisionId ?? null, ...extra };
}
async function change(action, extra = {}, options = {}) {
  stash();
  const result = await request(action, activeInput(extra));
  if (options.clearDraft) localStorage.removeItem(stashKey(documentId));
  await load();
  notice(options.message ?? "已保存");
  return result;
}

for (const region of ["navigation", "pipeline"]) {
  const button = byId(`${region}-toggle`);
  button.onclick = () => {
    const scrollBox = document.scrollingElement;
    const span = scrollBox.scrollHeight - scrollBox.clientHeight;
    const ratio = span > 0 ? scrollBox.scrollTop / span : 0;
    const panel = byId(region);
    panel.hidden = !panel.hidden;
    byId("layout").classList.toggle(`without-${region}`, panel.hidden);
    button.setAttribute("aria-pressed", String(!panel.hidden));
    requestAnimationFrame(() => { scrollBox.scrollTop = ratio * (scrollBox.scrollHeight - scrollBox.clientHeight); });
  };
}
editor.addEventListener("input", stash);
byId("projects").onchange = (event) => {
  const selected = event.currentTarget.value;
  void perform(async () => {
    stash();
    projectId = selected;
    documentId = "";
    await load();
  });
};
form("new-project", async (values, node) => {
  stash();
  projectId = (await request("project.create", values)).id;
  documentId = "";
  node.reset();
  await load();
});
form("new-document", async (values, node) => {
  stash();
  documentId = (await request("document.create", { ...values, projectId })).id;
  node.reset();
  await load();
});
click("save", () => change("draft.save", { body: editor.value }, { clearDraft: true }));
click("review-pass", () => change("chapter.review", { accept: true }));
click("review-reject", () => change("chapter.review", { accept: false }));
click("finalize", () => change("draft.finalize"));
form("qa", async (values) => {
  const result = await change("article.qa", {
    score: Number(values.score), passed: values.passed === "on",
    fails: values.fails.split("\n").map((line) => line.trim()).filter(Boolean),
  });
  notice([...result.hardGates, ...result.fails].join(" · ") || `质检已记录 · ${result.overall} 分`);
});
click("refine", () => change("article.refine", { body: editor.value }, { clearDraft: true }));
click("accept", () => change("article.accept", { accept: true }));
click("reject", () => change("article.accept", { accept: false }));
click("approve", () => window.confirm("批准将当前版本导出为交稿单？") && change("approval.decide", { confirmed: true }));
click("deliver", async () => {
  const result = await change("article.deliver", { key: `delivery:${snapshot.active.revisionId}` });
  notice(result.state === "exported" ? "交稿单已生成" : "已记录交稿，文件导出失败，可从此处重试。", result.state !== "exported");
});
form("start-run", (values) => change("run.start", { ...values, tokenLimit: Number(values.tokenLimit) }));
form("complete-run", async (values, node) => {
  await change("run.complete", { ...values, tokens: Number(values.tokens), runId: currentRun().id });
  node.reset();
});
click("adopt", () => window.confirm("以这份候选稿更新工作稿？") && change("candidate.adopt", { key: candidate().candidateId, runId: candidate().id }, { clearDraft: true }));
click("discard", () => change("run.discard", { runId: candidate().id }));
click("cancel", () => change("run.cancel", { runId: currentRun().id }));
form("generate-run", async (values) => {
  const run = currentRun() ?? snapshot.runs?.[0];
  await change("run.generate", { ...values, autoQa: values.autoQa === "on", runId: run.id }, { message: "DsH 正在生成候选稿" });
  if (!poll) poll = setInterval(() => {
    if (!document.hidden) void perform(() => load(snapshot.asOfSeq));
  }, 2000);
});
click("refresh-run", async () => { stash(); await load(); });
form("chapter-outline", async (values) => {
  const result = await change("chapter.outline", { ...values, target: Number(values.target) });
  if (result.warnings.length) notice(result.warnings.join(" · "));
});
form("article-plan", (values) => change("article.plan", values));
form("setting-proposal", async (values, node) => {
  await change("setting.propose", {
    projectId, factId: values.factId, note: values.note, source: values.source, character: values.character,
    from: { chapterId: documentId, point: Number(values.point) }, locked: values.locked === "on",
  });
  node.reset();
});
form("settings-read", async (values) => {
  const result = await request("settings.read", { projectId, character: values.character, at: { chapterId: documentId, point: Number(values.point) } });
  byId("known-settings").replaceChildren(...(result.entries.length
    ? result.entries.map(({ note }) => element("p", note))
    : [element("p", "此时该人物没有已确认的知情设定。")]));
});
for (const [id, offset] of [["move-up", -1], ["move-down", 1]]) {
  click(id, async () => {
    const chapterIds = snapshot.documents.map(({ id }) => id);
    const position = chapterIds.indexOf(documentId);
    [chapterIds[position], chapterIds[position + offset]] = [chapterIds[position + offset], chapterIds[position]];
    const plan = await request("reorder.impact", { projectId, chapterIds });
    const impacts = plan.impact.flatMap(({ id, relations }) => relations.map(({ label }) => `${id} · ${label}`));
    if (window.confirm(impacts.length ? `本次调整影响：\n${impacts.join("\n")}\n确认调整章序？` : "确认调整章序？")) {
      await change("reorder.commit", { projectId, chapterIds, asOfSeq: plan.asOfSeq, confirmed: true });
    }
  });
}
void perform(load);
