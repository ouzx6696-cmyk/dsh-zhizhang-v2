import assert from "node:assert/strict";
import test from "node:test";
import {
  APPEARANCE_STORAGE_KEYS,
  applyAppearancePreferences,
  createAppearancePopover,
} from "../src/client/workbench/appearance.ts";
import { SEED_PACKS } from "../src/client/workbench/seed-packs.ts";
import { createNewBookWizard } from "../src/client/workbench/views/new-book-wizard.ts";
import { createOutlineBoardView } from "../src/client/workbench/views/outline-board.ts";
import { createStudyHome, LAST_ACTIVE_STORAGE_KEY } from "../src/client/workbench/views/study-home.ts";
import { createTreeSidebar } from "../src/client/workbench/views/tree-sidebar.ts";
import { createMemoryStorage, withBrowserGlobals } from "../support/v2-harness.mjs";

function createRichFakeDom() {
  function matchesSimple(node, sel) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) return false;
    const tagAttr = /^([a-z0-9]+)?\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/u.exec(sel);
    if (tagAttr) {
      if (tagAttr[1] && node.tagName.toLowerCase() !== tagAttr[1].toLowerCase()) return false;
      const attr = tagAttr[2];
      if (attr.startsWith("data-")) {
        const camel = attr.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase());
        return tagAttr[3] === undefined ? node.dataset[camel] !== undefined : node.dataset[camel] === tagAttr[3];
      }
      return node.attributes.has(attr);
    }
    if (sel.startsWith(".")) return node.className.split(/\s+/).includes(sel.slice(1));
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findAll(root, sel, out = []) {
    for (const c of root.children) {
      if (c.nodeType !== 1) continue;
      if (matchesSimple(c, sel)) out.push(c);
      findAll(c, sel, out);
    }
    return out;
  }

  function createNode(tagName) {
    const classSet = new Set();
    const listeners = new Map();
    const styleStore = {};
    const node = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      type: "",
      value: "",
      placeholder: "",
      rows: 0,
      min: "",
      max: "",
      checked: false,
      disabled: false,
      hidden: false,
      open: false,
      clientHeight: 360,
      scrollTop: 0,
      children: [],
      parentElement: null,
      dataset: {},
      attributes: new Map(),
      _text: "",
      onclick: null,
      onchange: null,
      oninput: null,
      style: {
        setProperty(k, v) {
          styleStore[k] = v;
        },
        getPropertyValue(k) {
          return styleStore[k] ?? "";
        },
        set height(v) {
          styleStore.height = v;
        },
        get height() {
          return styleStore.height;
        },
        set transform(v) {
          styleStore.transform = v;
        },
        get transform() {
          return styleStore.transform;
        },
      },
      get className() {
        return [...classSet].join(" ");
      },
      set className(v) {
        classSet.clear();
        for (const t of String(v || "").split(/\s+/).filter(Boolean)) classSet.add(t);
      },
      classList: {
        toggle(cls, force) {
          if (force === undefined) {
            if (classSet.has(cls)) {
              classSet.delete(cls);
              return false;
            }
            classSet.add(cls);
            return true;
          }
          if (force) classSet.add(cls);
          else classSet.delete(cls);
          return Boolean(force);
        },
        contains(cls) {
          return classSet.has(cls);
        },
      },
      get textContent() {
        if (node.children.length === 0) return node._text;
        return node._text + node.children.map((c) => c.textContent ?? "").join("");
      },
      set textContent(v) {
        node._text = String(v ?? "");
        node.children = [];
      },
      setAttribute(name, val) {
        node.attributes.set(name, String(val));
      },
      append(...items) {
        for (const item of items) {
          if (!item) continue;
          if (item._isFrag) {
            for (const f of item.children) {
              f.parentElement = node;
              node.children.push(f);
            }
          } else if (typeof item === "string") {
            node.children.push({ nodeType: 3, textContent: item, children: [], parentElement: node });
          } else {
            item.parentElement = node;
            node.children.push(item);
          }
        }
      },
      replaceChildren(...items) {
        node._text = "";
        node.children = [];
        node.append(...items);
      },
      showModal() {
        node.open = true;
      },
      close() {
        node.open = false;
      },
      closest(sel) {
        let cur = node;
        while (cur) {
          if (matchesSimple(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        return findAll(node, sel)[0] ?? null;
      },
      querySelectorAll(sel) {
        return findAll(node, sel);
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
      dispatchEvent(evt) {
        const eventObj = { target: node, ...evt };
        let cur = node;
        while (cur) {
          for (const fn of cur === node ? listeners.get(evt.type) ?? [] : cur._listeners?.get(evt.type) ?? []) {
            fn(eventObj);
          }
          cur = cur.parentElement;
        }
        return true;
      },
      _listeners: listeners,
      click() {
        node.onclick?.();
        node.dispatchEvent({ type: "click" });
      },
    };
    return node;
  }

  function countAllElements(root) {
    let count = 0;
    for (const c of root.children) {
      if (c.nodeType === 1) count += 1 + countAllElements(c);
    }
    return count;
  }

  const body = createNode("body");
  const documentElement = createNode("html");
  class FakeOption {
    constructor(label, value) {
      this.textContent = label;
      this.value = value;
      this.nodeType = 1;
      this.tagName = "OPTION";
      this.children = [];
    }
  }

  return {
    createNode,
    countAllElements,
    FakeOption,
    doc: {
      body,
      documentElement,
      createElement: (tag) => createNode(tag),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
      createDocumentFragment: () => ({
        _isFrag: true,
        children: [],
        append(...n) {
          for (const item of n) {
            if (item?._isFrag) this.children.push(...item.children);
            else if (item) this.children.push(item);
          }
        },
      }),
    },
  };
}

function buildLargeTree(volumeCount, chaptersPerVolume) {
  const volumes = [];
  const acts = [];
  const chapters = [];
  for (let v = 1; v <= volumeCount; v++) {
    const volId = `vol-${v}`;
    const actId = `act-${v}`;
    volumes.push({
      id: volId,
      projectId: "proj-5k",
      title: `第${v}卷`,
      goal: `卷目标${v}`,
      summary: "",
      sortOrder: v,
      createdAt: v,
    });
    acts.push({
      id: actId,
      projectId: "proj-5k",
      volumeId: volId,
      title: `第${v}幕`,
      goal: `幕目标${v}`,
      summary: "",
      arcGoal: `弧线目标${v}`,
      sortOrder: 1,
      createdAt: v,
    });
    for (let c = 1; c <= chaptersPerVolume; c++) {
      const n = (v - 1) * chaptersPerVolume + c;
      chapters.push({
        id: `ch-${n}`,
        title: `第${n}章 剧情推进`,
        state: "drafted",
        volumeId: volId,
        actId,
        charCount: 2200,
        summary: n === 4950 ? "关键线索：灰塔地下三层铜钥匙出现" : `第${n}章简短摘要`,
        targetLength: 2200,
        viewpoint: "林砚",
        syncStatus: "clean",
        order: n,
        updatedAt: n,
      });
    }
  }
  return {
    projectId: "proj-5k",
    volumes,
    acts,
    chapters,
    totalChars: volumeCount * chaptersPerVolume * 2200,
    asOfSeq: 5000,
  };
}

test("Sprint 4 UI #1: 5000-chapter virtualized tree-sidebar bounds DOM <= 45 and auto-expands filtered summary matches", async () => {
  const { createNode, countAllElements, doc } = createRichFakeDom();
  const container = createNode("nav");
  const selected = [];
  const tree = buildLargeTree(50, 100);

  await withBrowserGlobals({ document: doc, requestAnimationFrame: (fn) => fn() }, async () => {
    const sidebar = createTreeSidebar(container, (docId) => selected.push(docId));
    sidebar.renderNovelTree(tree, "ch-1");

    const renderedButtons = container.querySelectorAll("button").length;
    const totalDomElements = countAllElements(container);
    assert.ok(renderedButtons <= 20 && renderedButtons > 0, `Expected <=20 row buttons, got ${renderedButtons}`);
    assert.ok(totalDomElements <= 45, `Expected <=45 recursive DOM elements in sidebar, got ${totalDomElements}`);

    // Delegated volume collapse click
    const volBtn = container.querySelector("button[data-volume-toggle]");
    assert.ok(volBtn);
    volBtn.click();
    assert.equal(container.querySelectorAll("button[data-doc-id=\"ch-1\"]").length, 0);

    // Filter matching summary of chapter 4950 auto-expands even collapsed volumes
    sidebar.setFilter("灰塔地下三层铜钥匙");
    const matchedBtn = container.querySelector("button[data-doc-id=\"ch-4950\"]");
    assert.ok(matchedBtn, "Summary search must auto-expand volume and render matching chapter");
    matchedBtn.click();
    assert.deepEqual(selected, ["ch-4950"]);

    sidebar.destroy();
  });
});

test("Sprint 4 UI #2: 5000-chapter outline-board keeps initial DOM < 120, lazy-mounts editor, and saves Compass controls", async () => {
  const { createNode, countAllElements, FakeOption, doc } = createRichFakeDom();
  const container = createNode("div");
  const tree = buildLargeTree(50, 100);
  const requests = [];

  const mockHost = {
    getState: () => ({
      projectId: "proj-5k",
      documentId: "ch-1",
      snapshot: { projects: [{ id: "proj-5k", name: "五千章长篇", product: "fanqie" }] },
      composing: false,
      activeView: "outline",
    }),
    perform: async (work) => {
      await work();
    },
    selectDocument: async () => {},
    load: async () => {},
    notice: () => {},
    request: async (action, input) => {
      requests.push({ action, input });
      if (action === "tree.get") return tree;
      if (action === "proposal.list") return [];
      if (action === "controls.get") {
        return { projectId: "proj-5k", authorIntent: "初始指南针", currentFocus: "第1章焦点", updatedAt: 1 };
      }
      if (action === "controls.save") {
        return { projectId: "proj-5k", ...input, updatedAt: 2 };
      }
      return {};
    },
    modal: { confirm: async () => true, prompt: async () => null },
  };

  await withBrowserGlobals({ document: doc, Option: FakeOption }, async () => {
    const board = createOutlineBoardView(container, mockHost);
    await board.refresh();

    const totalDom = countAllElements(container);
    assert.ok(totalDom < 120, `Expected <120 DOM nodes on 5000-chapter outline initial paint, got ${totalDom}`);
    assert.equal(container.querySelectorAll("textarea").length, 0, "Collapsed initial paint must mount zero textareas");
    assert.equal(container.querySelectorAll("select").length, 0, "Collapsed initial paint must mount zero selects");

    // Expand one chapter lazily
    const expandBtn = container.querySelectorAll("button").find((b) => b.textContent === "展开编辑");
    assert.ok(expandBtn);
    expandBtn.click();
    assert.equal(container.querySelectorAll("textarea").length, 1);
    assert.equal(container.querySelectorAll("select").length, 1);

    // Edit Compass controls
    const editCtrlBtn = container.querySelectorAll("button").find((b) => b.textContent === "编辑控制面");
    assert.ok(editCtrlBtn);
    editCtrlBtn.click();
    const textareas = container.querySelectorAll("textarea");
    textareas[0].value = "更新全书指南针";
    textareas[1].value = "第2幕焦点";
    const saveCtrlBtn = container.querySelectorAll("button").find((b) => b.textContent === "保存控制面");
    await saveCtrlBtn.onclick();
    const savedReq = requests.find((r) => r.action === "controls.save");
    assert.equal(savedReq.input.authorIntent, "更新全书指南针");
    assert.equal(savedReq.input.currentFocus, "第2幕焦点");
  });
});

test("Sprint 4 UI #3: study-home, SEED_PACKS, 3-step new-book-wizard, and 3-theme appearance + reader typography", async () => {
  assert.ok(SEED_PACKS.length >= 4);
  const { createNode, FakeOption, doc } = createRichFakeDom();
  const storage = createMemoryStorage();
  storage.setItem(
    LAST_ACTIVE_STORAGE_KEY,
    JSON.stringify({ projectId: "p-fanqie", documentId: "doc-9", projectName: "灰塔长夜", title: "第九章" }),
  );

  const emptyEl = createNode("section");
  const events = [];
  const wizardRequests = [];

  await withBrowserGlobals(
    {
      document: doc,
      Option: FakeOption,
      localStorage: storage,
      window: { matchMedia: () => ({ matches: false }) },
    },
    async () => {
      const study = createStudyHome(emptyEl, {
        onSelectProject: (id) => events.push(["project", id]),
        onResumeDocument: (p, d) => events.push(["resume", p, d]),
        onOpenWizard: () => events.push(["wizard"]),
        onImportDemoBook: () => events.push(["demo"]),
      });
      study.update({
        projects: [
          { id: "p-fanqie", name: "灰塔长夜", product: "fanqie" },
          { id: "p-toutiao", name: "产业观察", product: "toutiao" },
        ],
      });

      assert.ok(emptyEl.querySelector(".hero-resume-card"), "Hero card should appear when lastActive matches");
      assert.equal(emptyEl.querySelectorAll(".bookshelf-card").length, 2);

      const resumeBtn = emptyEl.querySelectorAll("button").find((b) => b.textContent === "一键续写上一章");
      resumeBtn.click();
      assert.deepEqual(events[0], ["resume", "p-fanqie", "doc-9"]);

      const toutiaoTab = emptyEl.querySelectorAll("button").find((b) => b.textContent === "头条创作");
      toutiaoTab.click();
      assert.equal(emptyEl.querySelectorAll(".bookshelf-card").length, 1);

      // 3-step wizard test
      const completed = [];
      let lastPerform = Promise.resolve();
      const wizard = createNewBookWizard(
        {
          perform: (work) => {
            lastPerform = Promise.resolve(work());
            return lastPerform;
          },
          notice: () => {},
          request: async (action, input) => {
            wizardRequests.push({ action, input });
            if (action === "project.create") return { id: "new-proj" };
            if (action === "volume.create") return { id: "new-vol" };
            if (action === "document.create") return { id: "new-doc" };
            if (action === "technique.save") return { id: "new-tech" };
            return {};
          },
        },
        {
          onCompleted: async (pid, did) => completed.push({ pid, did }),
        },
      );
      wizard.open();
      const dlg = doc.body.querySelector("dialog");
      assert.equal(dlg.open, true);
      dlg.querySelector("input").value = "向导新书";
      dlg.querySelector("input").oninput();
      dlg.querySelectorAll("button").find((b) => b.textContent === "下一步").click();
      dlg.querySelectorAll("button").find((b) => b.textContent === "下一步").click();
      const submitBtn = dlg.querySelectorAll("button").find((b) => b.textContent === "创建并进入写作");
      submitBtn.click();
      await lastPerform;
      assert.deepEqual(completed, [{ pid: "new-proj", did: "new-doc" }]);
      assert.ok(wizardRequests.some((r) => r.action === "controls.save"));
      assert.ok(wizardRequests.some((r) => r.action === "library.mount"));

      // Paper themes & reader typography
      applyAppearancePreferences(
        doc.documentElement,
        "bamboo",
        { font: "kai", fontSize: 18, measure: 960 },
        false,
      );
      assert.equal(doc.documentElement.dataset.theme, "bamboo");
      assert.equal(doc.documentElement.style.getPropertyValue("--editor-font-size"), "18px");
      assert.equal(doc.documentElement.style.getPropertyValue("--editor-measure"), "960px");

      const topNav = createNode("nav");
      const themeBtn = createNode("button");
      topNav.append(themeBtn);
      createAppearancePopover(themeBtn);
      themeBtn.click(); // open popover
      const pop = topNav.querySelector(".appearance-popover");
      assert.ok(pop);
      pop.querySelectorAll("button").find((b) => b.textContent === "夜航").click();
      pop.querySelectorAll("button").find((b) => b.textContent === "楷体").click();
      assert.equal(storage.getItem(APPEARANCE_STORAGE_KEYS.theme), "night");
      assert.equal(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEYS.typography)).font, "kai");
    },
  );
});
