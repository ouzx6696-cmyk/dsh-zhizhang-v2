import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createWorkbenchFrameProps, resolveWorkbenchUrl, WORKBENCH_IFRAME_REFERRER_POLICY, WORKBENCH_IFRAME_SANDBOX } from "../src/client/slot.ts";
import { APPEARANCE_STORAGE_KEYS, createAppearancePopover } from "../src/client/workbench/appearance.ts";
import {
  computeInlineDiff,
  computeParagraphDiff,
  detectLineEnding,
  mergeParagraphSelections,
  splitIntoSentences,
  tokenizeForInlineDiff,
} from "../src/client/workbench/diff.ts";
import {
  createDiffWorkerClient,
  handleDiffWorkerMessage,
  isLargeDiff,
} from "../src/client/workbench/diff-worker.ts";
import { createDraftVault, DRAFT_VAULT_TTL_MS } from "../src/client/workbench/draft-vault.ts";
import { SEED_PACKS } from "../src/client/workbench/seed-packs.ts";
import { createDiffView } from "../src/client/workbench/views/diff-view.ts";
import {
  applySelectionReplacement,
  createSelectionMicrobar,
  resolveCapturedSelection,
} from "../src/client/workbench/views/selection-microbar.ts";
import { createTreeSidebar } from "../src/client/workbench/views/tree-sidebar.ts";
import { createVirtualList } from "../src/client/workbench/views/virtual-list.ts";
import { PACING } from "../src/domain/fanqie/editorial.ts";
import { TECHNIQUE_CATEGORIES } from "../src/domain/fanqie/library.ts";
import { createMemoryStorage, withBrowserGlobals } from "../support/v2-harness.mjs";

function createTestDom() {
  let activeElement = null;
  const docListeners = new Map();

  function matchesSelector(node, selector) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) return false;
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
    const tagAttr = /^([a-z0-9]+)?(?:\.([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\])?$/u.exec(selector);
    if (!tagAttr) return false;
    const [, tag, cls, attr, val] = tagAttr;
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (cls && !node.className.split(/\s+/).includes(cls)) return false;
    if (attr) {
      if (attr.startsWith("data-")) {
        const camel = attr.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase());
        const actual = node.dataset[camel];
        return val === undefined ? actual !== undefined : actual === val;
      }
      const actual = node.attributes.get(attr);
      return val === undefined ? actual !== undefined : actual === val;
    }
    return true;
  }

  function findAll(root, selector, out = []) {
    for (const child of root.children) {
      if (child.nodeType !== 1) continue;
      if (matchesSelector(child, selector)) out.push(child);
      findAll(child, selector, out);
    }
    return out;
  }

  function createNode(tagName, id = "") {
    const classSet = new Set();
    const listeners = new Map();
    const styleStore = {};
    const node = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      id,
      get type() {
        return node.attributes.get("type") ?? "";
      },
      set type(v) {
        node.attributes.set("type", String(v));
      },
      value: "",
      readOnly: false,
      selectionStart: 0,
      selectionEnd: 0,
      checked: false,
      disabled: false,
      hidden: false,
      tabIndex: 0,
      clientHeight: 360,
      scrollTop: 0,
      children: [],
      parentElement: null,
      dataset: {},
      attributes: new Map(),
      onclick: null,
      onchange: null,
      _text: "",
      _listeners: listeners,
      focusCalls: 0,
      style: {
        setProperty(k, v) {
          styleStore[k] = String(v);
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
      getAttribute(name) {
        return node.attributes.get(name) ?? null;
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === node) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      focus() {
        node.focusCalls++;
        activeElement = node;
        node.dispatchEvent({ type: "focusin" });
      },
      setSelectionRange(start, end) {
        node.selectionStart = start;
        node.selectionEnd = end;
      },
      setRangeText(replacement, start, end) {
        node.value = node.value.slice(0, start) + replacement + node.value.slice(end);
        node.selectionStart = start;
        node.selectionEnd = start + replacement.length;
      },
      append(...items) {
        for (const item of items) {
          if (!item) continue;
          if (item._isFrag) {
            for (const c of item.children) {
              c.parentElement = node;
              node.children.push(c);
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
      remove() {
        if (!node.parentElement) return;
        node.parentElement.children = node.parentElement.children.filter((c) => c !== node);
        node.parentElement = null;
      },
      closest(sel) {
        let cur = node;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
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
        let stopped = false;
        const eventObj = {
          target: node,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {
            stopped = true;
          },
          ...evt,
        };
        let cur = node;
        while (cur && !stopped) {
          for (const fn of [...(cur._listeners?.get(evt.type) ?? [])]) {
            fn(eventObj);
          }
          cur = cur.parentElement;
        }
        if (!stopped && evt.bubbles !== false) {
          for (const fn of [...(docListeners.get(evt.type) ?? [])]) {
            fn(eventObj);
          }
        }
        return true;
      },
      click() {
        let stopped = false;
        const evt = {
          type: "click",
          target: node,
          stopPropagation() {
            stopped = true;
          },
          preventDefault() {},
        };
        node.onclick?.(evt);
        if (!stopped) node.dispatchEvent(evt);
      },
    };
    return node;
  }

  const documentElement = createNode("html");
  const body = createNode("body");
  documentElement.append(body);

  const doc = {
    body,
    documentElement,
    get activeElement() {
      return activeElement;
    },
    set activeElement(v) {
      activeElement = v;
    },
    createElement: (tag) => createNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [], parentElement: null }),
    createDocumentFragment: () => ({
      _isFrag: true,
      children: [],
      append(...items) {
        for (const item of items) {
          if (item?._isFrag) this.children.push(...item.children);
          else if (item) this.children.push(item);
        }
      },
    }),
    addEventListener(type, fn) {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatchEvent(evt) {
      const eventObj = { target: body, preventDefault() {}, stopPropagation() {}, ...evt };
      for (const fn of [...(docListeners.get(evt.type) ?? [])]) fn(eventObj);
      return true;
    },
  };

  return { createNode, doc, getActiveElement: () => activeElement };
}

test("FE-01: selection-microbar validates captured documentId/offset, relocates unique shifts, and refuses stale/ambiguous/cross-chapter applies", async () => {
  const captured = {
    documentId: "ch-1",
    revisionId: "rev-1",
    start: 4,
    end: 14,
    text: "雨水敲打着铁皮棚顶。",
  };

  // Exact match
  assert.deepEqual(
    resolveCapturedSelection(captured, "ch-1", "前缀段落雨水敲打着铁皮棚顶。后文继续。"),
    { ok: true, start: 4, end: 14, relocated: false },
  );

  // Shifted by earlier insertion -> unique relocation succeeds
  assert.deepEqual(
    resolveCapturedSelection(captured, "ch-1", "新增前文内容，前缀段落雨水敲打着铁皮棚顶。后文继续。"),
    { ok: true, start: 11, end: 21, relocated: true },
  );

  // Modified inside selection -> refused
  assert.deepEqual(
    resolveCapturedSelection(captured, "ch-1", "前缀段落雨水敲打着木板屋顶。后文继续。"),
    { ok: false, reason: "not-found" },
  );

  // Shifted AND duplicated -> ambiguous, refused
  assert.deepEqual(
    resolveCapturedSelection(captured, "ch-1", "新增：雨水敲打着铁皮棚顶。中间。雨水敲打着铁皮棚顶。"),
    { ok: false, reason: "ambiguous" },
  );

  // Switched document -> refused
  assert.deepEqual(
    resolveCapturedSelection(captured, "ch-2", "前缀段落雨水敲打着铁皮棚顶。后文继续。"),
    { ok: false, reason: "document-changed" },
  );

  // End-to-end interactive microbar check: mutate editor during async request & switch chapters
  const { createNode, doc } = createTestDom();
  const wrap = createNode("div");
  const editor = createNode("textarea");
  editor.value = "开场。雨水敲打着铁皮棚顶。尾声。";
  editor.setSelectionRange(3, 13);
  wrap.append(editor);
  doc.body.append(wrap);

  let currentDocId = "ch-1";
  let pendingResolve = null;
  const notices = [];
  const mockHost = {
    getState: () => ({
      projectId: "p-1",
      documentId: currentDocId,
      snapshot: { active: { id: currentDocId, revisionId: "rev-1" } },
      composing: false,
      activeView: "writing",
    }),
    perform: async (work) => {
      await work();
    },
    request: () =>
      new Promise((resolve) => {
        pendingResolve = resolve;
      }),
    notice: (msg, isError = false) => notices.push({ msg, isError }),
    modal: { prompt: async () => null, confirm: async () => true },
  };

  await withBrowserGlobals({ document: doc }, async () => {
    const microbar = createSelectionMicrobar(editor, mockHost, {
      getProviderModel: () => ({ provider: "p", model: "m" }),
    });
    microbar.refresh();

    // Case 1: Edit inside selection while request is in-flight -> apply MUST refuse
    const polishBtn = wrap.querySelector('[data-selection-mode="polish"]');
    const req1 = polishBtn.onclick();
    editor.value = "开场。暴风刮过破旧棚顶。尾声。";
    pendingResolve({ rewrittenText: "暴雨砸在锈铁棚上。", tokens: 40, mode: "polish" });
    await req1;
    const applyBtn1 = wrap.querySelector('[data-selection-apply="true"]');
    assert.ok(applyBtn1);
    applyBtn1.click();
    assert.equal(editor.value, "开场。暴风刮过破旧棚顶。尾声。", "Modified selection must not be overwritten");
    assert.equal(notices.at(-1).isError, true);

    // Case 2: Preview opens, then author switches to ch-2 before clicking apply -> preview hides on refresh and apply refuses
    editor.value = "开场。雨水敲打着铁皮棚顶。尾声。";
    editor.setSelectionRange(3, 13);
    microbar.refresh();
    const req2 = polishBtn.onclick();
    pendingResolve({ rewrittenText: "暴雨砸在锈铁棚上。", tokens: 40, mode: "polish" });
    await req2;
    const previewCard = wrap.querySelector(".selection-diff-card");
    const staleApplyBtn = wrap.querySelector('[data-selection-apply="true"]');
    assert.equal(previewCard.hidden, false);

    currentDocId = "ch-2";
    editor.value = "第二章全新正文内容，不可被覆盖。";
    microbar.refresh();
    assert.equal(previewCard.hidden, true, "Switching documents must hide preview card");
    staleApplyBtn.click();
    assert.equal(editor.value, "第二章全新正文内容，不可被覆盖。", "Cross-chapter apply must never mutate target chapter");
    assert.equal(notices.at(-1).isError, true);

    // Case 3: Earlier insertion shifts selection uniquely -> relocates and replaces cleanly
    currentDocId = "ch-1";
    editor.value = "开场。雨水敲打着铁皮棚顶。尾声。";
    editor.setSelectionRange(3, 13);
    microbar.refresh();
    const req3 = polishBtn.onclick();
    editor.value = "新增前奏！开场。雨水敲打着铁皮棚顶。尾声。";
    pendingResolve({ rewrittenText: "暴雨砸在锈铁棚上。", tokens: 45, mode: "polish" });
    await req3;
    wrap.querySelector('[data-selection-apply="true"]').click();
    assert.equal(editor.value, "新增前奏！开场。暴雨砸在锈铁棚上。尾声。");

    microbar.destroy();
  });
});

test("FE-02: applySelectionReplacement prefers execCommand('insertText') with fallback, and microbar maintains 10-step AI undo stack", async () => {
  const { createNode, doc } = createTestDom();
  const wrap = createNode("div");
  const editor = createNode("textarea");
  wrap.append(editor);
  doc.body.append(wrap);

  let execCalls = 0;
  let execShouldSucceed = true;
  let inputCount = 0;
  editor.addEventListener("input", () => {
    inputCount++;
  });

  doc.execCommand = (cmd, _ui, value) => {
    execCalls++;
    if (cmd !== "insertText" || !execShouldSucceed) return false;
    editor.value = editor.value.slice(0, editor.selectionStart) + value + editor.value.slice(editor.selectionEnd);
    editor.dispatchEvent({ type: "input" });
    return true;
  };

  await withBrowserGlobals({ document: doc }, async () => {
    // 1. execCommand path succeeds and does NOT double-fire input event
    editor.value = "前文，原句片段，后文";
    const usedExec = applySelectionReplacement(editor, 3, 7, "新写片段");
    assert.equal(usedExec, true);
    assert.equal(execCalls, 1);
    assert.equal(editor.value, "前文，新写片段，后文");
    assert.equal(inputCount, 1);

    // 2. execCommand returns false -> cleanly falls back to setRangeText + input event
    execShouldSucceed = false;
    const usedFallback = applySelectionReplacement(editor, 3, 7, "回退片段");
    assert.equal(usedFallback, false);
    assert.equal(editor.value, "前文，回退片段，后文");
    assert.equal(inputCount, 2);

    // 3. 10-step bounded aiUndoStack + "撤销上次 AI 替换" button
    execShouldSucceed = true;
    editor.value = "开头：段落零零。结尾。";
    const notices = [];
    let step = 0;
    const mockHost = {
      getState: () => ({
        projectId: "p1",
        documentId: "doc-undo",
        snapshot: { active: { id: "doc-undo", revisionId: "r1" } },
        composing: false,
        activeView: "writing",
      }),
      perform: async (w) => {
        await w();
      },
      request: async () => ({ rewrittenText: `段落第${++step}版`, tokens: 20, mode: "polish" }),
      notice: (m) => notices.push(m),
      modal: { prompt: async () => null, confirm: async () => true },
    };

    const microbar = createSelectionMicrobar(editor, mockHost, {
      getProviderModel: () => ({ provider: "p", model: "m" }),
    });
    const polishBtn = wrap.querySelector('[data-selection-mode="polish"]');

    // Perform 12 sequential AI replacements; stack must cap at 10
    for (let i = 0; i < 12; i++) {
      const targetStart = editor.value.indexOf("段落");
      const targetEnd = editor.value.indexOf("。结尾");
      editor.setSelectionRange(targetStart, targetEnd);
      microbar.refresh();
      await polishBtn.onclick();
      wrap.querySelector('[data-selection-apply="true"]').click();
    }
    assert.equal(editor.value, "开头：段落第12版。结尾。");
    assert.equal(microbar.getUndoDepth(), 10, "AI undo stack must cap at 10 steps");

    const undoBtn = wrap.querySelector('[data-selection-undo="true"]');
    assert.ok(undoBtn && undoBtn.hidden === false);
    assert.equal(undoBtn.textContent, "撤销上次 AI 替换");

    // Click undo button twice -> steps back 12 -> 11 -> 10
    undoBtn.click();
    assert.equal(editor.value, "开头：段落第11版。结尾。");
    assert.equal(microbar.getUndoDepth(), 9);
    undoBtn.click();
    assert.equal(editor.value, "开头：段落第10版。结尾。");
    assert.equal(microbar.getUndoDepth(), 8);

    // Exhaust remaining 8 steps -> stops cleanly at step 2 (steps 1 and 0 evicted by 10-step cap)
    let remaining = 0;
    while (microbar.undoLastReplacement()) remaining++;
    assert.equal(remaining, 8);
    assert.equal(editor.value, "开头：段落第2版。结尾。");
    assert.equal(undoBtn.hidden, true);
    microbar.destroy();
  });
});

test("FE-06: virtual-list sets --vrow-h, observes container resize, and preserves focusedKey across repaints", async () => {
  const { createNode, doc, getActiveElement } = createTestDom();
  let resizeCallback = null;
  let disconnected = false;
  class FakeResizeObserver {
    constructor(cb) {
      resizeCallback = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }

  await withBrowserGlobals(
    { document: doc, ResizeObserver: FakeResizeObserver, requestAnimationFrame: (fn) => fn() },
    async () => {
      const container = createNode("nav");
      container.clientHeight = 180;
      doc.body.append(container);

      const vlist = createVirtualList(container, {
        rowHeight: 36,
        overscan: 2,
        directThreshold: 40,
        getKey: (item) => `k:${item.id}`,
        renderItem: (item) => {
          const btn = createNode("button");
          btn.textContent = item.title;
          return btn;
        },
      });

      assert.equal(container.style.getPropertyValue("--vrow-h"), "36px");

      const items = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: `第${i + 1}章` }));
      vlist.setItems(items);
      const viewport = container.querySelector(".vlist-window");
      const initialCount = viewport.children.length;

      // Focus item 3, then repaint -> focus must be restored onto the recreated button with the same key
      const btn3 = viewport.children[2];
      btn3.focus();
      assert.equal(getActiveElement(), btn3);
      vlist.refresh();
      assert.equal(getActiveElement()?.dataset?.vlistKey, "k:3");
      assert.notEqual(getActiveElement(), btn3, "Focus must transfer to freshly rendered DOM node");

      // Container grows -> ResizeObserver expands rendered slice
      container.clientHeight = 540;
      assert.ok(resizeCallback, "ResizeObserver must be registered");
      resizeCallback([]);
      assert.ok(viewport.children.length > initialCount, "Growing container must render more rows");

      vlist.destroy();
      assert.equal(disconnected, true, "destroy() must disconnect ResizeObserver");
    },
  );
});

test("FE-10 & FE-34: workbench.css defines complete theme tokens with zero dark-media override or undefined vars, and enforces 36px vlist & sticky/drawer/busy-bar rules", () => {
  const css = readFileSync(new URL("../src/client/workbench.css", import.meta.url), "utf8");

  // 1. Conflicting prefers-color-scheme: dark override removed
  assert.equal(css.includes(':root:not([data-theme="light"])'), false);
  assert.equal(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/u.test(css), false);

  // 2. Undefined legacy vars eliminated
  assert.equal(css.includes("var(--danger"), false);
  assert.equal(css.includes("var(--accent-ink"), false);
  assert.equal(css.includes("var(--surface-alt"), false);

  // 3. Complete semantic token set in ALL 3 themes (ink-paper, bamboo, night)
  const requiredTokens = [
    "--background",
    "--surface",
    "--surface-subtle",
    "--border",
    "--foreground",
    "--muted-foreground",
    "--primary",
    "--primary-hover",
    "--primary-foreground",
    "--success",
    "--warning",
    "--destructive",
    "--diff-add-bg",
    "--diff-del-bg",
    "--diff-chg-bg",
    "--diff-char-del-bg",
    "--diff-char-del-fg",
    "--diff-char-ins-bg",
    "--diff-char-ins-fg",
  ];

  function extractThemeBlock(themeName) {
    const re = new RegExp(`:root\\[data-theme="${themeName}"\\][^{]*\\{([^}]+)\\}`, "u");
    const match = re.exec(css);
    assert.ok(match, `Missing CSS theme block for data-theme="${themeName}"`);
    return match[1];
  }

  for (const theme of ["ink-paper", "bamboo", "night"]) {
    const block = extractThemeBlock(theme);
    for (const token of requiredTokens) {
      assert.ok(
        new RegExp(`${token}\\s*:`).test(block),
        `Theme "${theme}" is missing required semantic token ${token}`,
      );
    }
  }

  // 4. FE-06 vlist strict zero-gap & --vrow-h height
  assert.match(css, /\.vlist-window\s*\{[^}]*gap:\s*0/u);
  assert.match(css, /\.vlist-window\s*>\s*\*\s*\{[^}]*height:\s*var\(--vrow-h,\s*36px\)/u);
  assert.match(css, /\.vlist-window\s*>\s*\*\s*\{[^}]*box-sizing:\s*border-box/u);

  // 5. FE-34 sticky sidebars, container query, drawer, busy bar, paragraph gutter & badge
  assert.match(css, /\.sidebar\s*\{[^}]*position:\s*sticky[^}]*max-height:\s*calc\(100dvh\s*-\s*52px\)/u);
  assert.match(css, /@container\s+workbench-layout\s*\(max-width:\s*960px\)/u);
  assert.match(css, /\.busy-bar\b/u);
  assert.match(css, /\.editor-gutter\b/u);
  assert.match(css, /\.paragraph-badge\b/u);

  // 6. Every CSS var(--*) referenced anywhere in workbench.css must be defined or runtime-bound
  const definedVars = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gu)].map((m) => m[1]));
  const runtimeInjectedVars = new Set([
    "--editor-font-family",
    "--editor-font-size",
    "--editor-measure",
    "--vrow-h",
  ]);
  for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gu)) {
    const varName = match[1];
    assert.ok(
      definedVars.has(varName) || runtimeInjectedVars.has(varName),
      `workbench.css references undefined CSS variable ${varName}`,
    );
  }
});

test("FE-11: appearance popover tracks prefers-color-scheme & host postMessage in auto mode and closes on Escape/outside click with focus restore", async () => {
  const { createNode, doc, getActiveElement } = createTestDom();
  const storage = createMemoryStorage();
  const topNav = createNode("nav");
  const outsideArea = createNode("main");
  const themeBtn = createNode("button");
  topNav.append(themeBtn);
  doc.body.append(topNav, outsideArea);

  const mediaListeners = new Set();
  const mql = {
    matches: false,
    addEventListener(type, fn) {
      if (type === "change") mediaListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "change") mediaListeners.delete(fn);
    },
  };
  const winListeners = new Map();
  const mockWindow = {
    matchMedia: () => mql,
    addEventListener(type, fn) {
      const list = winListeners.get(type) ?? [];
      list.push(fn);
      winListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };

  await withBrowserGlobals(
    {
      document: doc,
      window: mockWindow,
      localStorage: storage,
      location: { origin: "https://dsh.local" },
    },
    async () => {
      const ctrl = createAppearancePopover(themeBtn);
      assert.equal(doc.documentElement.dataset.theme, "ink-paper");

      // System dark mode flips while in auto mode -> switches to night live
      mql.matches = true;
      for (const fn of mediaListeners) fn({ matches: true });
      assert.equal(doc.documentElement.dataset.theme, "night");

      // Host postMessage override from same origin updates auto mode
      for (const fn of winListeners.get("message") ?? []) {
        fn({ origin: "https://dsh.local", data: { type: "dsh:theme", theme: "light" } });
      }
      assert.equal(doc.documentElement.dataset.theme, "ink-paper");

      // Untrusted cross-origin message is ignored
      for (const fn of winListeners.get("message") ?? []) {
        fn({ origin: "https://evil.example", data: { type: "dsh:theme", theme: "dark" } });
      }
      assert.equal(doc.documentElement.dataset.theme, "ink-paper");

      // Open popover -> focuses active option; click option inside does NOT close popover
      themeBtn.click();
      const pop = topNav.querySelector(".appearance-popover");
      assert.ok(pop && pop.hidden === false);
      const bambooBtn = pop.querySelectorAll("button").find((b) => b.textContent === "青简");
      bambooBtn.click();
      assert.equal(doc.documentElement.dataset.theme, "bamboo");
      assert.equal(storage.getItem(APPEARANCE_STORAGE_KEYS.theme), "bamboo");
      assert.equal(pop.hidden, false, "Picking an option inside popover must keep popover open");

      // Escape closes popover and returns focus to toggle button
      doc.dispatchEvent({ type: "keydown", key: "Escape" });
      assert.equal(pop.hidden, true);
      assert.equal(getActiveElement(), themeBtn);

      // Re-open and click outside -> closes popover and returns focus to button
      themeBtn.click();
      assert.equal(pop.hidden, false);
      outsideArea.click();
      assert.equal(pop.hidden, true);
      assert.equal(getActiveElement(), themeBtn);

      ctrl.destroy();
      assert.equal(mediaListeners.size, 0);
    },
  );
});

test("FE-12: diff-view preserves partial adoption payload in raw mode and renders 1-click return-to-split banner", async () => {
  const { createNode, doc } = createTestDom();
  const container = createNode("section", "comparison");
  const summaryEl = createNode("div", "diff-summary");
  const bodyEl = createNode("div", "diff-surface");
  const rawEl = createNode("textarea", "candidate");
  const qaEl = createNode("p", "candidate-qa");
  const adoptBtn = createNode("button", "adopt");
  const modeSplit = createNode("button");
  modeSplit.dataset.diffMode = "split";
  const modeInline = createNode("button");
  modeInline.dataset.diffMode = "inline";
  const modeRaw = createNode("button");
  modeRaw.dataset.diffMode = "raw";
  container.append(summaryEl, bodyEl, rawEl, qaEl, adoptBtn, modeSplit, modeInline, modeRaw);
  doc.body.append(container);

  await withBrowserGlobals({ document: doc }, async () => {
    const view = createDiffView(container);
    view.update({
      candidateId: "cand-fe12",
      originalBody: "第一段。\n第二段原稿。\n第三段原稿。",
      candidateBody: "第一段。\n第二段改写。\n第三段改写。",
      refinementRounds: 0,
      canAdopt: true,
    });

    // Uncheck second hunk -> partial
    const cbs = bodyEl.querySelectorAll('input[type="checkbox"]');
    assert.equal(cbs.length, 2);
    cbs[1].checked = false;
    cbs[1].onchange();
    assert.equal(view.getAdoptionPayload().adoptionMode, "partial");

    // Switch to raw mode -> payload MUST remain partial (NEVER silently flip to full!)
    modeRaw.click();
    const rawPayload = view.getAdoptionPayload();
    assert.equal(rawPayload.adoptionMode, "partial");
    assert.equal(rawPayload.selectedCount, 1);
    assert.equal(rawPayload.totalHunks, 2);
    assert.equal(rawPayload.mergedBody, "第一段。\n第二段改写。\n第三段原稿。");

    // Raw mode shows partial banner with 1-click button back to split view
    assert.equal(bodyEl.hidden, false);
    const banner = bodyEl.querySelector('[data-raw-partial-banner="true"]');
    assert.ok(banner, "Partial selection banner must be shown in raw mode");
    assert.match(banner.textContent, /1 \/ 2/);
    const backBtn = bodyEl.querySelector('[data-diff-back-split="true"]');
    assert.ok(backBtn);
    backBtn.click();

    // Returned to split view with partial selection preserved
    assert.equal(rawEl.hidden, true);
    const splitCbs = bodyEl.querySelectorAll('input[type="checkbox"]');
    assert.equal(splitCbs[0].checked, true);
    assert.equal(splitCbs[1].checked, false);
  });
});

test("FE-13: blank-line spacers attach to adjacent hunks and original CRLF/LF line endings are preserved", async () => {
  // 1. Candidate only converts single-newline to double-newline: all selected == candidate, none == original
  const singleOrig = "第一段\n第二段\n第三段";
  const doubleCand = "第一段\n\n第二段\n\n第三段";
  const blankOnlyDiff = computeParagraphDiff(singleOrig, doubleCand);
  const allBlankIndices = new Set(
    blankOnlyDiff.rows.map((r, i) => (r.kind !== "equal" ? i : -1)).filter((i) => i !== -1),
  );
  assert.equal(mergeParagraphSelections(blankOnlyDiff, allBlankIndices), doubleCand);
  assert.equal(mergeParagraphSelections(blankOnlyDiff, new Set()), singleOrig);

  // Also test blank-only toggle through createDiffView ("全选变更" vs "全不选")
  const { createNode, doc } = createTestDom();
  const container = createNode("section", "comparison");
  const summaryEl = createNode("div", "diff-summary");
  const bodyEl = createNode("div", "diff-surface");
  const rawEl = createNode("textarea", "candidate");
  const qaEl = createNode("p", "candidate-qa");
  const adoptBtn = createNode("button", "adopt");
  container.append(summaryEl, bodyEl, rawEl, qaEl, adoptBtn);
  await withBrowserGlobals({ document: doc }, async () => {
    const view = createDiffView(container);
    view.update({
      candidateId: "cand-blank",
      originalBody: singleOrig,
      candidateBody: doubleCand,
      refinementRounds: 0,
      canAdopt: true,
    });
    assert.equal(view.getAdoptionPayload().mergedBody, doubleCand);
    const noneBtn = bodyEl.querySelectorAll("button").find((b) => b.textContent === "全不选");
    noneBtn.click();
    assert.equal(view.getAdoptionPayload().mergedBody, singleOrig);
    const allBtn = bodyEl.querySelectorAll("button").find((b) => b.textContent === "全选变更");
    allBtn.click();
    assert.equal(view.getAdoptionPayload().mergedBody, doubleCand);
  });

  // 2. Mixed blank-line spacers attached to adjacent non-blank hunk
  const mixedOrig = "第一段\n第二段原文\n第三段";
  const mixedCand = "第一段\n\n第二段改写\n\n第三段";
  const mixedDiff = computeParagraphDiff(mixedOrig, mixedCand);
  const changedRowIdx = mixedDiff.rows.findIndex((r) => r.kind === "changed");
  assert.ok(changedRowIdx !== -1, "Blank spacers must not steal pairing from non-blank modified paragraph");
  assert.equal(mergeParagraphSelections(mixedDiff, new Set([changedRowIdx])), mixedCand);
  assert.equal(mergeParagraphSelections(mixedDiff, new Set()), mixedOrig);

  // 3. CRLF preservation
  const crlfOrig = "第一段\r\n第二段原文\r\n第三段原文";
  const lfCand = "第一段\n第二段改写\n第三段改写";
  assert.equal(detectLineEnding(crlfOrig), "\r\n");
  assert.equal(detectLineEnding(lfCand), "\n");
  const crlfDiff = computeParagraphDiff(crlfOrig, lfCand);
  assert.equal(crlfDiff.lineEnding, "\r\n");
  assert.equal(mergeParagraphSelections(crlfDiff, new Set([1])), "第一段\r\n第二段改写\r\n第三段原文");
});

test("FE-14 & Res#20: Patience paragraph anchors, Myers inline diff 30x200 benchmark (<30ms & >=95% LCS accuracy), and diff-worker wrapper", async () => {
  // 1. Patience unique-anchor paragraph diff handles middle insertion in 600+ paragraphs without cascading changes
  const paras600 = Array.from({ length: 600 }, (_, i) => `第${i + 1}段：林砚沿灰塔石阶拾级而上，记录编号${1000 + i}。`);
  const withMiddleInsert = [...paras600.slice(0, 300), "中间新插入的独立过渡段。", ...paras600.slice(300)];
  const patDiff = computeParagraphDiff(paras600.join("\n"), withMiddleInsert.join("\n"));
  assert.equal(patDiff.unchanged, 600);
  assert.equal(patDiff.added, 1);
  assert.equal(patDiff.changed, 0);
  assert.equal(patDiff.removed, 0);

  // 2. Long Chinese paragraph (> 350 chars, m*n > 120,000) keeps fine-grained inline diff instead of whole-paragraph fallback
  const longSentences = Array.from(
    { length: 14 },
    (_, i) => `第${i + 1}句描写雨夜档案馆内的铜铃微震与冷风掠过书脊的细微声响。`,
  );
  const longBefore = longSentences.join("");
  const modifiedSentences = [...longSentences];
  modifiedSentences[6] = "第7句描写雨夜档案馆内的锈蚀铜铃剧烈摇晃与冷风掠过书脊的细微声响。";
  const longAfter = modifiedSentences.join("");
  assert.ok(longBefore.length > 350);
  assert.equal(splitIntoSentences(longBefore).join(""), longBefore);
  const longSegs = computeInlineDiff(longBefore, longAfter);
  assert.ok(longSegs.some((s) => s.kind === "removed" && s.text === "微震"));
  assert.ok(longSegs.some((s) => s.kind === "added" && s.text === "剧烈摇晃"));
  assert.equal(longSegs.filter((s) => s.kind !== "added").map((s) => s.text).join(""), longBefore);
  assert.equal(longSegs.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), longAfter);

  // 3. Exact reference O(MN) DP LCS for accuracy verification
  function exactDpLcsLength(a, b) {
    const m = a.length;
    const n = b.length;
    let prev = new Uint32Array(n + 1);
    let curr = new Uint32Array(n + 1);
    for (let i = m - 1; i >= 0; i--) {
      curr.fill(0);
      for (let j = n - 1; j >= 0; j--) {
        curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[0];
  }

  // Deterministic PRNG for 30 paragraphs x ~200 CJK chars benchmark
  let seed = 20261120;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const vocab = "林砚推开沉重铁门雨点敲打青石长廊微光照亮旧卷宗桌角铜钥匙冰凉气息蔓延夜色深处脚步声渐近低语回荡窗棂";
  const makeSentence = (len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += vocab[Math.floor(rand() * vocab.length)];
    return `${s}。`;
  };

  const origParas = [];
  const candParas = [];
  for (let p = 0; p < 30; p++) {
    const sents = Array.from({ length: 8 }, () => makeSentence(24)); // 8 * 25 = 200 chars/paragraph
    origParas.push(sents.join(""));
    const edited = [...sents];
    // Mutate 2 sentences per paragraph with char insertions, deletions, and substitutions
    for (const targetIdx of [2, 5]) {
      const chars = [...edited[targetIdx]];
      chars.splice(5, 3, "骤", "然", "停", "住");
      chars.splice(14, 2);
      edited[targetIdx] = chars.join("");
    }
    candParas.push(edited.join(""));
  }
  const origDoc = origParas.join("\n");
  const candDoc = candParas.join("\n");

  // Warm up JIT once, then measure
  computeParagraphDiff(origDoc, candDoc);

  const t0 = performance.now();
  const benchDiff = computeParagraphDiff(origDoc, candDoc);
  const inlineResults = [];
  for (const row of benchDiff.rows) {
    if (row.kind === "changed") {
      inlineResults.push({
        left: row.leftText,
        right: row.rightText,
        segs: computeInlineDiff(row.leftText, row.rightText),
      });
    }
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 30, `30x200 diff benchmark exceeded 30ms gate: ${elapsedMs.toFixed(2)}ms`);

  // Verify lossless reconstruction & >= 95% LCS accuracy across all 30 paragraphs
  let totalLcsActual = 0;
  let totalLcsOptimal = 0;
  for (const item of inlineResults) {
    assert.equal(item.segs.filter((s) => s.kind !== "added").map((s) => s.text).join(""), item.left);
    assert.equal(item.segs.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), item.right);
    const equalTokens = item.segs
      .filter((s) => s.kind === "equal")
      .reduce((sum, s) => sum + tokenizeForInlineDiff(s.text).length, 0);
    totalLcsActual += equalTokens;
    totalLcsOptimal += exactDpLcsLength(tokenizeForInlineDiff(item.left), tokenizeForInlineDiff(item.right));
  }
  const accuracy = totalLcsActual / totalLcsOptimal;
  assert.ok(accuracy >= 0.95, `Inline diff accuracy vs exact DP LCS below 95%: ${(accuracy * 100).toFixed(2)}%`);

  // 3b. Randomized single-sentence Myers optimality check (50 pairs) + D > 2000 fallback guard
  for (let trial = 0; trial < 50; trial++) {
    const lenA = 15 + Math.floor(rand() * 45);
    const lenB = 15 + Math.floor(rand() * 45);
    const smallVocab = "甲乙丙丁戊己庚辛";
    let aStr = "";
    let bStr = "";
    for (let i = 0; i < lenA; i++) aStr += smallVocab[Math.floor(rand() * smallVocab.length)];
    for (let i = 0; i < lenB; i++) bStr += smallVocab[Math.floor(rand() * smallVocab.length)];
    const segs = computeInlineDiff(aStr, bStr);
    assert.equal(segs.filter((s) => s.kind !== "added").map((s) => s.text).join(""), aStr);
    assert.equal(segs.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), bStr);
    const eqLen = segs.filter((s) => s.kind === "equal").reduce((s, x) => s + x.text.length, 0);
    assert.equal(eqLen, exactDpLcsLength([...aStr], [...bStr]), `Myers optimality mismatch on trial ${trial}`);
  }

  // D > 2000 guard degrades gracefully in <20ms and remains lossless
  const hugeA = `前缀${"甲".repeat(1200)}后缀`;
  const hugeB = `前缀${"乙".repeat(1200)}后缀`;
  const hugeSegs = computeInlineDiff(hugeA, hugeB);
  assert.equal(hugeSegs.filter((s) => s.kind !== "added").map((s) => s.text).join(""), hugeA);
  assert.equal(hugeSegs.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), hugeB);
  assert.equal(hugeSegs[0].kind, "equal");
  assert.equal(hugeSegs[0].text, "前缀");
  assert.equal(hugeSegs.at(-1).kind, "equal");
  assert.equal(hugeSegs.at(-1).text, "后缀");

  // 4. diff-worker.ts unit checks (pure handler, threshold detection, Worker dispatch + error fallback)
  assert.equal(isLargeDiff("短文本", "短文本"), false);
  assert.equal(isLargeDiff("a\n".repeat(2100), "b\n".repeat(2100)), true);

  const paraResp = handleDiffWorkerMessage({ id: 1, op: "paragraph", original: "甲\n乙", candidate: "甲\n丙" });
  assert.equal(paraResp.ok, true);
  assert.equal(paraResp.result.changed, 1);

  const inlineResp = handleDiffWorkerMessage({ id: 2, op: "inline", before: "林砚推门", after: "林砚轻推门" });
  assert.equal(inlineResp.ok, true);
  assert.ok(inlineResp.result.some((s) => s.kind === "added" && s.text === "轻"));

  // Mock worker path (async dispatch) + worker error graceful fallback
  let workerPosted = 0;
  const mockClient = createDiffWorkerClient({
    createWorker: () => {
      const listeners = new Map();
      return {
        addEventListener(type, fn) {
          listeners.set(type, fn);
        },
        postMessage(req) {
          workerPosted++;
          queueMicrotask(() => {
            if (req.op === "inline" && req.before === "TRIGGER_ERR") {
              listeners.get("error")?.({ message: "simulated crash" });
              return;
            }
            listeners.get("message")?.({ data: handleDiffWorkerMessage(req) });
          });
        },
        terminate() {},
      };
    },
  });

  const workerResult = await mockClient.computeParagraphDiffAsync("第一段\n旧段", "第一段\n新段", { forceWorker: true });
  assert.equal(workerPosted, 1);
  assert.equal(workerResult.changed, 1);

  // Worker error transparently falls back to synchronous compute without rejecting
  const fallbackResult = await mockClient.computeInlineDiffAsync("TRIGGER_ERR", "TRIGGER_OK", { forceWorker: true });
  assert.ok(fallbackResult.some((s) => s.kind === "added" && s.text.includes("OK")));
  mockClient.terminate();
});

test("FE-19: tree-sidebar exposes APG tree/treeitem semantics and full Up/Down/Left/Right/Enter keyboard navigation", async () => {
  const treeSrc = readFileSync(new URL("../src/client/workbench/views/tree-sidebar.ts", import.meta.url), "utf8");
  assert.equal(/fanqie|toutiao|微头条/u.test(treeSrc), false, "tree-sidebar must stay product-line agnostic");

  const { createNode, doc, getActiveElement } = createTestDom();
  const container = createNode("nav");
  doc.body.append(container);

  const selected = [];
  const tree = {
    projectId: "p-kbd",
    volumes: [{ id: "v1", projectId: "p-kbd", title: "第一卷", goal: "", summary: "", sortOrder: 1, createdAt: 1 }],
    acts: [{ id: "a1", projectId: "p-kbd", volumeId: "v1", title: "第一幕", goal: "", summary: "", arcGoal: "", sortOrder: 1, createdAt: 1 }],
    chapters: [
      { id: "c1", title: "第一章", state: "drafted", volumeId: "v1", actId: "a1", charCount: 2000, summary: "", targetLength: 2000, viewpoint: "", syncStatus: "clean", order: 1, updatedAt: 1 },
      { id: "c2", title: "第二章", state: "drafting", volumeId: "v1", actId: "a1", charCount: 1800, summary: "", targetLength: 2000, viewpoint: "", syncStatus: "dirty", order: 2, updatedAt: 2 },
    ],
    totalChars: 3800,
    asOfSeq: 10,
  };

  await withBrowserGlobals({ document: doc, requestAnimationFrame: (fn) => fn() }, async () => {
    const sidebar = createTreeSidebar(container, (id) => selected.push(id));
    sidebar.renderNovelTree(tree, "c1");

    assert.equal(container.getAttribute("role"), "tree");
    const items = container.querySelectorAll('[role="treeitem"]');
    assert.equal(items.length, 4); // vol1, act1, c1, c2
    assert.equal(items[0].getAttribute("aria-level"), "1");
    assert.equal(items[0].getAttribute("aria-expanded"), "true");
    assert.equal(items[1].getAttribute("aria-level"), "2");
    assert.equal(items[2].getAttribute("aria-level"), "3");
    assert.equal(items[2].getAttribute("aria-selected"), "true");
    assert.equal(items[2].tabIndex, 0, "Active chapter gets initial roving tabIndex=0");
    assert.equal(items[0].tabIndex, -1);

    // ArrowDown from c1 -> focuses c2; Enter selects c2
    items[2].focus();
    items[2].dispatchEvent({ type: "keydown", key: "ArrowDown" });
    assert.equal(getActiveElement()?.dataset?.docId, "c2");
    getActiveElement().dispatchEvent({ type: "keydown", key: "Enter" });
    assert.deepEqual(selected, ["c2"]);

    // ArrowLeft from chapter c2 -> jumps focus to parent act a1
    getActiveElement().dispatchEvent({ type: "keydown", key: "ArrowLeft" });
    assert.equal(getActiveElement()?.dataset?.actToggle, "a1");

    // ArrowLeft on expanded act a1 -> collapses a1 and preserves focus on a1
    getActiveElement().dispatchEvent({ type: "keydown", key: "ArrowLeft" });
    assert.equal(getActiveElement()?.dataset?.actToggle, "a1");
    assert.equal(getActiveElement()?.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelectorAll('button[data-doc-id]').length, 0);

    // ArrowRight on collapsed act a1 -> expands a1; second ArrowRight -> enters first child c1
    getActiveElement().dispatchEvent({ type: "keydown", key: "ArrowRight" });
    assert.equal(getActiveElement()?.dataset?.actToggle, "a1");
    assert.equal(getActiveElement()?.getAttribute("aria-expanded"), "true");
    getActiveElement().dispatchEvent({ type: "keydown", key: "ArrowRight" });
    assert.equal(getActiveElement()?.dataset?.docId, "c1");

    // ArrowUp -> act a1; Home -> volume v1; End -> chapter c2
    getActiveElement().dispatchEvent({ type: "keydown", key: "ArrowUp" });
    assert.equal(getActiveElement()?.dataset?.actToggle, "a1");
    getActiveElement().dispatchEvent({ type: "keydown", key: "Home" });
    assert.equal(getActiveElement()?.dataset?.volumeToggle, "v1");
    getActiveElement().dispatchEvent({ type: "keydown", key: "End" });
    assert.equal(getActiveElement()?.dataset?.docId, "c2");

    sidebar.destroy();
  });
});

test("DSH-17 & FE-23: slot iframe enforces sandbox, referrerPolicy, clean URL resolution, and distinct conversation preview mode", async () => {
  // 1. Nested route baseURI with location.origin resolves cleanly to root /api/zhizhang/workbench
  await withBrowserGlobals(
    {
      window: {},
      location: { origin: "https://dsh.local", href: "https://dsh.local/conversations/abc-123" },
      document: { baseURI: "https://dsh.local/conversations/abc-123", querySelector: () => null },
    },
    async () => {
      const mainProps = createWorkbenchFrameProps({ view: "main" });
      const convProps = createWorkbenchFrameProps({ view: "conversation" });
      assert.equal(mainProps.src, "https://dsh.local/api/zhizhang/workbench");
      assert.equal(convProps.src, "https://dsh.local/api/zhizhang/workbench?view=conversation");
      assert.notEqual(mainProps.title, convProps.title);
      assert.equal(mainProps.sandbox, WORKBENCH_IFRAME_SANDBOX);
      assert.equal(convProps.sandbox, WORKBENCH_IFRAME_SANDBOX);
      assert.equal(mainProps.referrerPolicy, WORKBENCH_IFRAME_REFERRER_POLICY);
      assert.equal(convProps.referrerPolicy, "same-origin");
      assert.equal(mainProps.allow, "clipboard-write");
    },
  );

  // 2. Host metadata apiBase takes precedence
  await withBrowserGlobals(
    {
      window: { __DSH_CLIENT__: { apiBase: "https://host.example/dsh-sub" } },
      location: { origin: "https://host.example" },
      document: { baseURI: "https://host.example/conversations/1", querySelector: () => null },
    },
    async () => {
      assert.equal(resolveWorkbenchUrl({ view: "main" }).href, "https://host.example/dsh-sub/api/zhizhang/workbench");
      assert.equal(
        resolveWorkbenchUrl({ view: "conversation" }).href,
        "https://host.example/dsh-sub/api/zhizhang/workbench?view=conversation",
      );
    },
  );
});

test("FE-31: DraftVault stamps savedAt and prunes stale drafts older than 30 days on init", async () => {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);

  local.setItem(
    "zhizhang:draft:stale-doc",
    JSON.stringify({ body: "过期草稿", revisionId: "r-old", owner: "other", savedAt: nowMs - DRAFT_VAULT_TTL_MS - 1000 }),
  );
  local.setItem(
    "zhizhang:draft:fresh-doc",
    JSON.stringify({ body: "近期草稿", revisionId: "r-new", owner: "other", savedAt: nowMs - 5 * 24 * 60 * 60 * 1000 }),
  );
  local.setItem("zhizhang:theme", "bamboo");

  await withBrowserGlobals({ localStorage: local, sessionStorage: session }, async () => {
    const vault = createDraftVault(() => {}, { now: () => nowMs });

    // Stale >30d draft pruned on init; fresh draft & unrelated keys preserved
    assert.equal(local.getItem("zhizhang:draft:stale-doc"), null);
    assert.deepEqual(vault.read("fresh-doc"), { body: "近期草稿", revisionId: "r-new" });
    assert.equal(local.getItem("zhizhang:theme"), "bamboo");

    // Newly written draft stamps savedAt in storage while keeping read() cleanly typed
    vault.write("active-doc", { body: "新草稿", revisionId: "r-1" });
    const rawLocal = JSON.parse(local.getItem("zhizhang:draft:active-doc"));
    const rawSession = JSON.parse(session.getItem("zhizhang:draft:active-doc"));
    assert.equal(rawLocal.savedAt, nowMs);
    assert.equal(rawSession.savedAt, nowMs);
    assert.deepEqual(vault.read("active-doc"), { body: "新草稿", revisionId: "r-1" });
  });
});

test("FE-32 & FQ-31: SEED_PACKS ships curated multi-genre packs with categories & pacing aligned to Fanqie domain tables", () => {
  assert.ok(SEED_PACKS.length >= 6, `Expected >= 6 seed packs, got ${SEED_PACKS.length}`);
  const validCategories = new Set(TECHNIQUE_CATEGORIES);
  const validPacing = new Set(Object.keys(PACING));
  assert.ok(validCategories.has("atmosphere"), "atmosphere must be in TECHNIQUE_CATEGORIES");

  const ids = new Set();
  for (const pack of SEED_PACKS) {
    assert.equal(ids.has(pack.id), false, `Duplicate seed pack id ${pack.id}`);
    ids.add(pack.id);
    assert.ok(pack.techniques.length > 0, `Seed pack ${pack.id} must include techniques`);
    for (const tech of pack.techniques) {
      assert.ok(validCategories.has(tech.category), `Invalid category "${tech.category}" in ${pack.id}/${tech.id}`);
      assert.ok(validPacing.has(tech.pacing), `Invalid pacing "${tech.pacing}" in ${pack.id}/${tech.id}`);
    }
  }
  assert.ok(SEED_PACKS.some((p) => p.product === "fanqie" && p.id === "ancient-court-intrigue"));
  assert.ok(SEED_PACKS.some((p) => p.product === "fanqie" && p.id === "scifi-apocalypse"));
  assert.ok(SEED_PACKS.some((p) => p.product === "toutiao" && p.id === "toutiao-character-profile"));
});
