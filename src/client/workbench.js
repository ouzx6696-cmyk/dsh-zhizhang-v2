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
let loadSequence = 0;
let editSequence = 0;
let editorBase;
const draftOwner = Array.from(crypto.getRandomValues(new Uint32Array(2))).join("-");

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
  if (!packet || typeof packet.ok !== "boolean") throw new Error("工作台返回了无法识别的结果。");
  if (!packet.ok) {
    const fields = packet.details ?? {};
    const reason = fields.reason ?? fields.field;
    const message = ({
      "generation-in-progress": "该稿件已有活动任务，请先完成或取消当前任务。",
      "generation-needs-reconciliation": "上一次任务仍在结束或等待用量核对。请刷新任务查看状态。",
      "export.conflict": "目标文件与获批稿件不同，请处理同名文件后重试。",
    })[reason] ?? (packet.code === "version.conflict"
      ? "稿件版本已更新。本地编辑已保留，请刷新后核对再保存。"
      : [packet.code, reason].filter(Boolean).join(" · "));
    throw new Error(packet.diagnosticId ? `${message}（诊断号 ${packet.diagnosticId}）` : message);
  }
  return packet.result;
}

const localDrafts = new Map();
let stashTimer;
let storageUnavailable = false;
let composing = false;
let directoryKey = "";
let selectedDirectoryButton;
let directoryButtons = new Map();
let chapterTitles = new Map();
let settingProject;
let settingsKey;
let toolDocument;

function stashKey(id) { return `zhizhang:draft:${id}`; }
function readStash(id) {
  if (localDrafts.has(id)) return localDrafts.get(id);
  let draft = null;
  try {
    let tabDraft;
    try { tabDraft = sessionStorage.getItem(stashKey(id)); } catch {}
    draft = JSON.parse(tabDraft ?? localStorage.getItem(stashKey(id)) ?? "null");
  } catch {}
  localDrafts.set(id, draft);
  return draft;
}
function writeStash(id, draft) {
  const previous = readStash(id);
  if (draft?.body === previous?.body && draft?.revisionId === previous?.revisionId && !storageUnavailable) return;
  localDrafts.set(id, draft);
  const key = stashKey(id);
  let stored = false;
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
    stored = true;
  } catch {}
  try {
    if (draft) localStorage.setItem(key, JSON.stringify({ ...draft, owner: draftOwner }));
    else {
      const backup = JSON.parse(localStorage.getItem(key) ?? "null");
      if (backup?.owner === draftOwner ||
          previous && backup?.body === previous.body && backup.revisionId === previous.revisionId) {
        localStorage.removeItem(key);
      }
    }
    stored = true;
  } catch {}
  storageUnavailable = !stored;
  if (!stored) {
    notice("浏览器暂时无法保留本地草稿。请保存正文后再离开。", true);
  }
}
function stash() {
  clearTimeout(stashTimer);
  if (!editorBase) return;
  const { id, revisionId, body } = editorBase;
  const draft = readStash(id);
  const base = draft ? draft.revisionId : revisionId;
  writeStash(id, base === revisionId && editor.value === body ? null : { body: editor.value, revisionId: base });
}
function dirty() {
  if (!editorBase) return false;
  const draft = readStash(editorBase.id);
  return editor.value !== editorBase.body || Boolean(draft && draft.revisionId !== editorBase.revisionId);
}
function element(tag, label) {
  const entry = document.createElement(tag);
  entry.textContent = label;
  return entry;
}
function candidate() { return snapshot.runs?.find((run) => run.state === "awaiting-author"); }
function uncertainRun() { return snapshot.runs?.find((run) => run.generationState === "uncertain"); }
function currentRun() { return snapshot.runs?.find((run) => run.state === "running"); }

function settingPoint({ chapterId, point }) {
  return `${chapterTitles.get(chapterId) ?? chapterId}第 ${point} 段`;
}

function appendSettings(target, entries) {
  for (const entry of entries) {
    const row = element("section", "");
    row.append(element("p", `${entry.fact.id} · ${entry.fact.note} · ${({ approved: "已确认", rejected: "已拒绝", pending: "待确认" })[entry.decision]}`));
    const { source, effectiveFrom, effectiveTo, knownFrom } = entry.fact;
    row.append(element("p", [source, `${settingPoint(effectiveFrom)}生效`,
      effectiveTo && `${settingPoint(effectiveTo)}起失效`,
      ...Object.entries(knownFrom).map(([name, at]) => `${name}在${settingPoint(at)}知情`),
    ].filter(Boolean).join(" · ")));
    if (entry.decision === "pending") {
      for (const [label, accept] of [["确认设定", true], ["拒绝提案", false]]) {
        const button = element("button", label);
        button.onclick = () => perform(() => change("setting.decide", { projectId, proposalId: entry.id, accept }));
        row.append(button);
      }
    }
    target.append(row);
  }
}

function settingChapters(select) {
  const value = select.value;
  select.replaceChildren(new Option(select.dataset.default, ""),
    ...Array.from(chapterTitles, ([id, title]) => new Option(title, id)));
  if (chapterTitles.has(value)) select.value = value;
}

function showSettingExpiry() {
  const form = byId("setting-proposal");
  const expires = Boolean(form.elements.toChapter.value);
  byId("setting-to-point").hidden = !expires;
  form.elements.toPoint.disabled = !expires;
}

function titleCount(field, output, titled) {
  const length = [...field.value.trim()].length;
  output.textContent = titled ? `${length} / 34 字符` : "";
  field.setCustomValidity(titled && length > 34 ? "标题最多 34 个字符" : "");
}

function showBudget() {
  const form = byId("start-run");
  const active = snapshot.active;
  if (!active) return;
  const input = JSON.stringify([active.body, active.title, snapshot.planning, snapshot.scenario, form.elements.instruction.value]);
  const estimate = new TextEncoder().encode(input).length + 1024;
  const recommended = Math.max(8000, Math.ceil((estimate * 2 + 2400) / 1000) * 1000);
  const field = form.elements.tokenLimit;
  if (toolDocument !== active.id || !field.value || field.value === field.dataset.suggested) field.value = recommended;
  field.dataset.suggested = recommended;
  byId("budget-hint").textContent = `正文与规划的保守输入估算约 ${estimate} token。建议总额 ${recommended}，含输出余量；多轮质检另消耗额度。`;
  byId("run-point").hidden = active.product !== "fanqie";
  form.elements.point.disabled = active.product !== "fanqie";
}

function render() {
  const projects = byId("projects");
  const navigation = byId("documents");
  const project = snapshot.projects?.find((item) => item.id === projectId);
  const active = snapshot.active;
  const article = project?.product === "toutiao";
  const hasDraft = Boolean(active?.revisionId);
  const locked = ["final", "已验收", "已交稿"].includes(active?.state);
  const nextDirectoryKey = JSON.stringify([projectId, snapshot.projects, snapshot.documents]);
  if (nextDirectoryKey !== directoryKey) {
    directoryKey = nextDirectoryKey;
    projects.replaceChildren(element("option", "选择项目"));
    projects.firstChild.value = "";
    for (const item of snapshot.projects ?? []) {
      const choice = element("option", item.name);
      choice.value = item.id;
      projects.append(choice);
    }
    directoryButtons = new Map();
    chapterTitles = new Map();
    for (const item of snapshot.documents ?? []) {
      const button = element("button", item.title || "微头条");
      directoryButtons.set(item.id, button);
      chapterTitles.set(item.id, item.title || "微头条");
      button.setAttribute("aria-current", "false");
      button.onclick = () => perform(async () => {
        stash();
        byId("known-settings").replaceChildren();
        documentId = item.id;
        await load();
      });
    }
    navigation.replaceChildren(...directoryButtons.values());
    if (settingProject !== projectId) {
      settingProject = projectId;
      byId("setting-proposal").reset();
      byId("setting-people").replaceChildren();
    }
    for (const select of byId("setting-proposal").querySelectorAll("[data-setting-chapters]")) settingChapters(select);
    showSettingExpiry();
  }
  projects.value = projectId;
  const selectedButton = directoryButtons.get(documentId);
  if (selectedButton !== selectedDirectoryButton) {
    selectedDirectoryButton?.setAttribute("aria-current", "false");
    selectedButton?.setAttribute("aria-current", "true");
    selectedDirectoryButton = selectedButton;
  }
  byId("document-tools").hidden = !project;
  byId("article-options").hidden = !article;
  updateNewTitle();
  byId("empty").hidden = Boolean(active);
  byId("manuscript").hidden = !active;
  byId("flow-empty").hidden = Boolean(active);
  byId("flow-content").hidden = !active;
  editorBase = active ? { id: active.id, revisionId: active.revisionId, body: active.body ?? "" } : undefined;
  if (!active) return;

  byId("document-label").textContent = article ? "头条创作" : "番茄连载";
  byId("heading").textContent = active.title || "微头条";
  byId("state").textContent = stages[active.state] ?? active.state;
  const saved = readStash(active.id);
  const stale = saved && saved.revisionId !== active.revisionId;
  const visibleBody = saved?.body ?? active.body ?? "";
  if (editor.value !== visibleBody && !composing) editor.value = visibleBody;
  editor.readOnly = locked || Boolean(stale);
  byId("save").disabled = locked;
  const draftStatus = byId("draft-status");
  draftStatus.replaceChildren(document.createTextNode(stale ? "有一份基于旧版本的本地编辑。" : saved ? "已恢复本地编辑" : hasDraft ? "已保存" : "尚未保存"));
  if (stale) {
    const compare = element("details", "");
    compare.append(element("summary", "查看服务器正文"), element("pre", active.body ?? ""));
    draftStatus.append(compare);
    const copy = element("button", "复制本地稿");
    copy.onclick = () => perform(async () => {
      await navigator.clipboard.writeText(editor.value);
      notice("已复制本地稿");
    });
    draftStatus.append(" ", copy);
    byId("save").disabled = true;
    const restore = element("button", "使用服务器版本");
    restore.onclick = () => {
      if (!window.confirm("丢弃这份基于旧版本的本地编辑？")) return;
      writeStash(active.id, null);
      render();
    };
    draftStatus.append(" ", restore);
  }
  const rename = byId("rename");
  rename.hidden = !article || active.mode === "micro" || locked;
  if (rename.dataset.title !== active.title) {
    rename.dataset.title = active.title;
    rename.elements.title.value = active.title;
  }
  titleCount(rename.elements.title, byId("title-count"), !rename.hidden);
  const titles = byId("title-choices");
  const plannedTitles = snapshot.planning?.titleMatrix?.valid?.map(({text}) => text) ?? [];
  if (titles.dataset.titles !== JSON.stringify(plannedTitles)) {
    titles.dataset.titles = JSON.stringify(plannedTitles);
    titles.replaceChildren(new Option("选择候选", ""), ...plannedTitles.map(title => new Option(title)));
  }
  const report = snapshot.report;
  byId("article-report").hidden = !report;
  byId("article-report").textContent = report?.overall !== undefined
    ? [`最近质检 ${report.overall} 分`, ...(report.hardGates ?? []), ...(report.fails ?? [])].join(" · ")
    : report ? `验收退回 ${report.reason || "请修订后重新质检"}` : "";
  const exportStatus = snapshot.exportStatus;
  const approvedVersion = byId("approved-version");
  approvedVersion.hidden = !snapshot.approved;
  approvedVersion.textContent = snapshot.approved ? `获批修订 ${(exportStatus?.revisionId ?? active.revisionId).slice(0, 8)}` : "";
  byId("export-status").hidden = !exportStatus;
  byId("export-status").textContent = ({
    exported: "已写入交稿文件", pending: "已记录交稿，等待写入文件",
    failed: String(exportStatus?.error).includes("export.conflict") ? "存在同名的不同文件，请处理冲突后重试" : "已记录交稿，文件写入失败",
  })[exportStatus?.state] ?? "";
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
  const nextSettingsKey = JSON.stringify([projectId, snapshot.settings, snapshot.settingsCursor]);
  if (nextSettingsKey !== settingsKey) {
    settingsKey = nextSettingsKey;
    const settingList = byId("settings");
    settingList.replaceChildren();
    appendSettings(settingList, snapshot.settings ?? []);
    byId("settings-more").hidden = !snapshot.settingsCursor;
    byId("settings-more").dataset.cursor = snapshot.settingsCursor ?? "";
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
  const run = currentRun() ?? uncertainRun() ?? snapshot.runs?.[0];
  byId("comparison").hidden = !pending || locked;
  byId("candidate").value = pending?.candidateBody ?? "";
  const candidateQa = pending?.candidateQa ? JSON.parse(pending.candidateQa) : undefined;
  byId("candidate-qa").hidden = !candidateQa;
  byId("candidate-qa").textContent = candidateQa
    ? [`候选稿质检 ${candidateQa.overall} 分 · 回改 ${pending.refinementRounds} 轮`, ...candidateQa.fails, ...candidateQa.hardGates].join(" · ") : "";
  byId("automatic-qa").hidden = !article;
  byId("adopt").disabled = pending?.baseRevisionId !== active.revisionId;
  byId("run-content").hidden = !run;
  byId("start-run").querySelector("button").disabled = !hasDraft || locked || Boolean(currentRun() || pending) || run?.generationState === "uncertain";
  byId("estimate-budget").disabled = !hasDraft || locked;
  showBudget();
  if (toolDocument !== active.id) {
    toolDocument = active.id;
    byId("run-history-list").replaceChildren();
    byId("run-input").hidden = true;
  }
  byId("run-status").textContent = run ? ({ running: "等待候选稿", "awaiting-author": "等待作者决定", applied: "已采纳", discarded: "已舍弃", failed: "任务失败", cancelled: "已取消" })[run.state] ?? run.state : "";
  if (run?.generationError) byId("run-status").append(` · ${run.generationError}`);
  const uncertain = run?.generationState === "uncertain";
  byId("reconcile").hidden = !uncertain;
  if (uncertain) byId("run-status").append(" · 请先查 DsH 提供方用量，再确认未记账部分");
  byId("run-detail").dataset.run = run?.id ?? "";
  byId("complete-run").hidden = run?.state !== "running";
  byId("generate-run").hidden = locked || uncertain || !["running", "failed"].includes(run?.state);
  if (!poll && run?.state === "running" && ["prepared", "inflight", "received"].includes(run.generationState)) {
    poll = setInterval(() => {
      if (!document.hidden && !composing) void perform(() => load(snapshot.asOfSeq));
    }, 2000);
  }
  if (poll && run?.state !== "running") {
    clearInterval(poll);
    poll = undefined;
  }
  byId("cancel").hidden = run?.state !== "running";
}

async function load(ifSequence) {
  const sequence = ++loadSequence;
  const selection = [projectId, documentId];
  const next = await request(undefined, undefined, ifSequence);
  if (sequence !== loadSequence || selection[0] !== projectId || selection[1] !== documentId) return;
  if (!next || !Array.isArray(next.projects) && next.unchanged !== true) throw new Error("工作台响应格式有误，请刷新后重试。");
  if (next.unchanged) return;
  stash();
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
  return { documentId, baseRevisionId: editorBase?.revisionId ?? null, ...extra };
}
async function change(action, extra = {}, options = {}) {
  if (options.savedVersion && dirty()) throw new Error("请先保存正文，或复制本地稿后切回已保存版本。");
  const submittedSequence = editSequence;
  const committedBody = action === "candidate.adopt" ? candidate()?.candidateBody : extra.body ?? editor.value;
  stash();
  const result = await request(action, activeInput(extra));
  if (options.clearDraft) {
    const id = editorBase.id;
    editorBase = { id, revisionId: result.revisionId, body: committedBody };
    if (editSequence === submittedSequence && !composing && editor.value !== committedBody) editor.value = committedBody;
    const remaining = editor.value === committedBody ? null : { body: editor.value, revisionId: result.revisionId };
    writeStash(id, remaining);
  }
  await load();
  if (!storageUnavailable) notice(options.message ?? "已保存");
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
editor.addEventListener("input", () => {
  editSequence++;
  clearTimeout(stashTimer);
  stashTimer = setTimeout(stash, 250);
});
editor.addEventListener("compositionstart", () => { composing = true; });
editor.addEventListener("compositionend", () => { composing = false; stash(); });
editor.addEventListener("blur", stash);
window.addEventListener("pagehide", stash);
document.addEventListener("visibilitychange", () => { if (document.hidden) stash(); });
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
click("review-pass", () => change("chapter.review", { accept: true }, { savedVersion: true }));
click("review-reject", () => change("chapter.review", { accept: false }, { savedVersion: true }));
click("finalize", () => change("draft.finalize", {}, { savedVersion: true }));
form("qa", async (values) => {
  const result = await change("article.qa", {
    score: Number(values.score), passed: values.passed === "on",
    fails: values.fails.split("\n").map((line) => line.trim()).filter(Boolean),
  }, { savedVersion: true });
  notice([...result.hardGates, ...result.fails].join(" · ") || `质检已记录 · ${result.overall} 分`);
});
click("refine", () => change("article.refine", { body: editor.value }, { clearDraft: true }));
click("accept", () => change("article.accept", { accept: true }, { savedVersion: true }));
click("reject", () => {
  const reason = window.prompt("验收退回原因", "");
  if (reason !== null) return change("article.accept", { accept: false, reason }, { savedVersion: true });
});
click("approve", () => window.confirm("批准将当前版本导出为交稿单？") && change("approval.decide", { confirmed: true }));
click("deliver", async () => {
  const result = await change("article.deliver", { key: `delivery:${snapshot.active.revisionId}` });
  notice(result.state === "exported" ? "交稿单已生成" : "已记录交稿，文件导出失败，可从此处重试。", result.state !== "exported");
});
form("start-run", (values) => change("run.start", {
  ...values, tokenLimit: Number(values.tokenLimit), point: Number(values.point || 1),
}, { savedVersion: true }));
click("estimate-budget", async () => {
  if (dirty()) throw new Error("保存当前正文后即可按该修订核算预算。");
  const { instruction, point, tokenLimit } = byId("start-run").elements;
  if (!instruction.reportValidity() || !point.reportValidity()) return;
  const { inputReserve, recommended } = await request("run.preview", activeInput({
    instruction: instruction.value, point: point.disabled ? 1 : Number(point.value || 1),
  }));
  if (!tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) tokenLimit.value = recommended;
  tokenLimit.dataset.suggested = recommended;
  const maxOutput = Math.max(0, Number(tokenLimit.value) - inputReserve);
  byId("budget-hint").textContent = `首轮写作预留约 ${inputReserve} token，当前额度最多可输出 ${maxOutput}。质检与回改使用任务剩余额度。`;
});
form("complete-run", async (values, node) => {
  await change("run.complete", { ...values, tokens: Number(values.tokens), runId: currentRun().id });
  node.reset();
});
click("adopt", () => window.confirm("以这份候选稿更新工作稿？") && change("candidate.adopt", { key: candidate().candidateId, runId: candidate().id }, { clearDraft: true, savedVersion: true }));
click("discard", () => change("run.discard", { runId: candidate().id }));
click("cancel", () => change("run.cancel", { runId: currentRun().id }));
form("generate-run", async (values) => {
  const run = currentRun() ?? uncertainRun() ?? snapshot.runs?.[0];
  await change("run.generate", { ...values, autoQa: values.autoQa === "on", runId: run.id }, { message: "DsH 正在生成候选稿" });
});
click("refresh-run", async () => { stash(); await load(); });
form("chapter-outline", async (values) => {
  const result = await change("chapter.outline", { ...values, target: Number(values.target) });
  if (result.warnings.length) notice(result.warnings.join(" · "));
});
form("article-plan", (values) => change("article.plan", values));
byId("setting-proposal").elements.toChapter.onchange = showSettingExpiry;
byId("setting-add-person").onclick = () => {
  const person = byId("setting-person-template").content.firstElementChild.cloneNode(true);
  settingChapters(person.querySelector("select"));
  person.querySelector("button").onclick = () => person.remove();
  byId("setting-people").append(person);
  person.querySelector("[data-person]").focus();
};
form("setting-proposal", async (values, node) => {
  const from = { chapterId: values.fromChapter || documentId, point: Number(values.point) };
  const people = Array.from(byId("setting-people").children, (row) => {
    const character = row.querySelector("[data-person]").value;
    const chapterId = row.querySelector("[data-when]").value;
    const point = row.querySelector("[data-point]").value;
    return { character, at: chapterId || point
      ? { chapterId: chapterId || from.chapterId, point: Number(point || (chapterId ? 1 : from.point)) }
      : undefined };
  });
  await change("setting.propose", {
    projectId, factId: values.factId, note: values.note, source: values.source, from, people,
    to: values.toChapter ? { chapterId: values.toChapter, point: Number(values.toPoint) } : undefined,
    locked: values.locked === "on",
  });
  node.reset();
  byId("setting-people").replaceChildren();
  showSettingExpiry();
});
form("settings-read", async (values) => {
  const result = await request("settings.read", { projectId, character: values.character, at: { chapterId: documentId, point: Number(values.point) } });
  byId("known-settings").replaceChildren(...(result.entries.length
    ? result.entries.map(({ note, source, locked, effectiveFrom, effectiveTo }) => element("p", [note, `来源 ${source}`, locked ? "已锁定" : "", `${settingPoint(effectiveFrom)}生效`, effectiveTo && `${settingPoint(effectiveTo)}起失效`].filter(Boolean).join(" · ")))
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
const newDocument = byId("new-document");
function updateNewTitle() {
  const titled = !byId("article-options").hidden && newDocument.elements.mode.value !== "micro";
  titleCount(newDocument.elements.title, byId("new-title-count"), titled);
}
newDocument.addEventListener("input", updateNewTitle);
const rename = byId("rename");
rename.elements.title.addEventListener("input", () => titleCount(rename.elements.title, byId("title-count"), true));
byId("title-choices").onchange = (event) => {
  if (event.target.value) rename.elements.title.value = event.target.value;
  titleCount(rename.elements.title, byId("title-count"), true);
};
form("rename", (values) => change("article.rename", values, { savedVersion: true, clearDraft: true }));
byId("start-run").elements.instruction.addEventListener("input", showBudget);
form("record-evidence", async (values) => {
  await change("evidence.record", values, { savedVersion: true, message: "已记录当前修订的正文证据" });
});
click("evidence-detail", async () => {
  const factId = byId("record-evidence").elements.factId.value;
  const { value } = await request("evidence.detail", activeInput({ factId }));
  const output = byId("evidence-result");
  const current = value.anchor?.chapterId === documentId && value.revisionId === snapshot.active.revisionId;
  output.textContent = current ? `第 ${value.anchor.point} 段 · ${snapshot.active.body.slice(value.quoteRange.start, value.quoteRange.end)}`
    : value.revisionId ? `第 ${value.anchor.point} 段 · 修订 ${value.revisionId}` : "暂无正文证据";
});
async function showRunDetail(runId) {
  const detail = await request("run.detail", activeInput({ runId }));
  const target = byId("run-input");
  target.hidden = false;
  target.textContent = JSON.stringify({
    frozenInput: JSON.parse(detail.frozenInput), candidate: detail.candidate,
    attempts: detail.attempts, calls: detail.calls?.map((call) => ({ ...call, usage: call.usage && JSON.parse(call.usage) })),
  }, null, 2);
  return detail;
}
click("run-detail", () => showRunDetail(byId("run-detail").dataset.run));
click("run-history", async () => {
  const target = byId("run-history-list");
  target.replaceChildren();
  async function page(before) {
    const entries = await request("run.history", activeInput({ before }));
    for (const entry of entries) {
      const button = element("button", `${entry.state} · ${entry.settled} / ${entry.reserved} token`);
      button.onclick = () => perform(() => showRunDetail(entry.id));
      target.append(button);
    }
    if (entries.length === 25) {
      const more = element("button", "下一页");
      more.onclick = () => perform(async () => { await page(entries.at(-1).cursor); more.remove(); });
      target.append(more);
    }
  }
  await page();
});
form("reconcile", async (values) => {
  const runId = byId("run-detail").dataset.run;
  const detail = await showRunDetail(runId);
  const attemptId = detail.attempts.find(({state}) => state === "uncertain")?.id;
  await change("run.reconcile", { runId, attemptId, tokens: Number(values.tokens) });
});
click("settings-more", async () => {
  const button = byId("settings-more");
  const result = await request("settings.history", { projectId, before: Number(button.dataset.cursor) });
  appendSettings(byId("settings"), result.entries);
  button.dataset.cursor = result.cursor ?? "";
  button.hidden = !result.cursor;
});
void perform(load);
