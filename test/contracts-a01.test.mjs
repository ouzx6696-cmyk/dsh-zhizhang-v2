import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for source and evidence location mechanics.
// Recorded from the v1.x core/text implementation (normalize.ts, locate.ts)
// as forensic evidence, not as the frozen V2 contract. The offset unit
// (UTF-16 code units vs code points), the normalization set and the fuzzy
// threshold are A-01 freeze items; this fixture records the v1.x behaviour
// and the divergence points without adjudicating any of them.
//
// v1.x additionally prioritises paragraphs whose ids the caller passed; this
// fixture keeps one ordered paragraph list because the mechanics under test
// do not depend on that grouping.

// v1.x normalize.ts: drops NBSP, zero-width and BOM characters; folds CRLF
// and CR to LF; collapses runs of newlines to at most two; trims trailing
// whitespace per line. Offsets are UTF-16 code units; no compatibility
// normalization is applied here (NFKC folding happens only in matchKey).
function normalizeText(text) {
  const chars = [];
  const offsets = [];
  let lineStart = 0;
  const trimEnd = () => {
    while (chars.length > lineStart && /\s/u.test(chars[chars.length - 1])) {
      chars.pop();
      offsets.pop();
    }
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\u00a0" || /[\u200b-\u200d\ufeff]/u.test(char)) continue;
    if (char === "\r" || char === "\n") {
      trimEnd();
      if (!(chars.at(-1) === "\n" && chars.at(-2) === "\n")) {
        chars.push("\n");
        offsets.push(i);
      }
      lineStart = chars.length;
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else {
      chars.push(char);
      offsets.push(i);
    }
  }
  trimEnd();
  return { text: chars.join(""), map: Int32Array.from(offsets) };
}

// v1.x locate.ts matchKey: grapheme segmentation, NFKC folding, lowercasing
// and stripping of whitespace, punctuation and symbols. Every surviving
// character maps back to the offset of its source grapheme.
function matchKey(text) {
  let key = "";
  const positions = [];
  for (const { segment: char, index: offset } of new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(text)) {
    const normalized = char
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{White_Space}\p{P}\p{S}]/gu, "");
    key += normalized;
    for (let i = 0; i < normalized.length; i++) positions.push(offset);
  }
  return { key, toOrig: Int32Array.from(positions) };
}

function grams(text) {
  const chars = [...matchKey(text).key];
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(1).map((char, i) => chars[i] + char));
}

function similar(a, b) {
  const left = grams(a);
  const right = grams(b);
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  return [...left].filter((value) => right.has(value)).length / union.size;
}

// v1.x locate.ts locateQuote: exact substring, then keyed match, then
// sentence-level fuzzy match at or above 0.8. A hit below the threshold is
// reported as unlocated with its score; nothing is fabricated.
const SENTENCE_RE = /[^。！？；…\n]+[。！？；…\n]*/gu;

function locateQuote(text, paras, quote) {
  const needle = matchKey(quote).key;
  if (!paras.length || !needle) return { located: false, score: 0 };
  let best = { located: false, score: 0 };
  for (const para of paras) {
    const body = text.slice(para.start, para.end);
    const exact = body.indexOf(quote);
    if (quote && exact >= 0) {
      return {
        located: "exact",
        para: para.id,
        start: para.start + exact,
        end: para.start + exact + quote.length,
        score: 1,
        text: quote,
      };
    }
    const keyed = matchKey(body);
    const index = keyed.key.indexOf(needle);
    if (index >= 0) {
      const start = para.start + keyed.toOrig[index];
      const last = para.start + keyed.toOrig[index + needle.length - 1];
      const tail = text.slice(last).match(/^.\p{M}*/u)?.[0] ?? "";
      return {
        located: "exact",
        para: para.id,
        start,
        end: last + tail.length,
        score: 1,
        text: text.slice(start, last + tail.length),
      };
    }
  }
  for (const para of paras) {
    const body = text.slice(para.start, para.end);
    for (const sentence of body.matchAll(SENTENCE_RE)) {
      const score = similar(sentence[0], quote);
      if (score > best.score) {
        best = {
          located: score >= 0.8 ? "fuzzy" : false,
          para: para.id,
          start: para.start + sentence.index,
          end: para.start + sentence.index + sentence[0].length,
          score,
          text: sentence[0],
        };
      }
    }
  }
  return best.located ? best : { located: false, score: best.score };
}

test("A-01 normalization drops invisible characters and folds line endings while keeping code-unit offsets", () => {
  const raw = "甲\u200b乙\r\n丙\u00a0丁";
  const result = normalizeText(raw);

  assert.equal(result.text, "甲乙\n丙丁");
  assert.deepEqual([...result.map], [0, 2, 3, 5, 7]);
  assert.equal(normalizeText("甲\n\n\n\n乙").text, "甲\n\n乙");
  assert.equal(normalizeText("甲  \n乙").text, "甲\n乙");
});

test("A-01 a quote locates through full-width, case and punctuation folding", () => {
  const text = "Ｈｅｌｌｏ，世界。";
  const hit = locateQuote(text, [{ id: "p1", start: 0, end: text.length }], "hello世界");

  assert.equal(hit.located, "exact");
  assert.equal(hit.para, "p1");
  assert.equal(hit.start, 0);
  assert.equal(hit.end, 8);
  assert.equal(hit.text, "Ｈｅｌｌｏ，世界");
});

test("A-01 a located range extends over trailing combining marks", () => {
  // Precomposed quote, decomposed source: both fold to the same key, and the
  // reported range covers the whole grapheme cluster of the last character.
  const text = "甲 cafe\u0301 乙";
  const hit = locateQuote(text, [{ id: "p1", start: 0, end: text.length }], "café");

  assert.equal(hit.located, "exact");
  assert.equal(hit.start, 2);
  assert.equal(hit.end, 7);
  assert.equal(hit.text, "cafe\u0301");
  assert.notEqual(hit.text, hit.text.normalize("NFC"));
  assert.equal(hit.text.normalize("NFC"), "café");
});

test("A-01 the same position differs between UTF-16 code units and code points for astral characters", () => {
  // v1.x TS reports UTF-16 code units; the Python rules side counts with
  // len(), i.e. code points. The V2 unit choice is an A-01 freeze item.
  const text = "甲😀乙";
  const para = { id: "p1", start: 0, end: text.length };

  const tail = locateQuote(text, [para], "乙");
  assert.equal(tail.located, "exact");
  assert.equal(tail.start, 3); // UTF-16 code units: 甲(1) + 😀(2)
  assert.equal(tail.end, 4);
  assert.equal([...text.slice(0, tail.start)].length, 2); // code points

  // The exact path keeps astral characters intact in its own range.
  const mixed = locateQuote(text, [para], "甲😀");
  assert.equal(mixed.located, "exact");
  assert.equal(mixed.start, 0);
  assert.equal(mixed.end, 3);
  assert.equal(mixed.text, "甲😀");
  assert.equal([...text.slice(0, mixed.end)].length, 2);

  // Recorded v1.x behaviour: matchKey strips symbols, so a quote made only of
  // symbols has an empty key and locateQuote reports it unlocated even though
  // the exact substring exists. Whether the V2 key keeps symbols is an A-01
  // freeze item.
  const emoji = locateQuote(text, [para], "😀");
  assert.equal(emoji.located, false);
  assert.equal(text.indexOf("😀"), 1);
});

test("A-01 a near match above the fuzzy threshold locates as fuzzy and below it stays unlocated", () => {
  // The quote is longer than the paragraph, so it cannot be a keyed substring;
  // it reaches the sentence-level fuzzy pass.
  const text = "去了市场买许多蔬果。";
  const para = { id: "p1", start: 0, end: text.length };

  const fuzzy = locateQuote(text, [para], "昨天去了市场买许多蔬果");
  assert.equal(fuzzy.located, "fuzzy");
  assert.ok(fuzzy.score >= 0.8);
  assert.equal(fuzzy.text, "去了市场买许多蔬果。");
  assert.equal(fuzzy.start, 0);
  assert.equal(fuzzy.end, text.length);

  const miss = locateQuote(text, [para], "完全不想干的另外一句话");
  assert.equal(miss.located, false);
  assert.equal(miss.score, 0);
});

test("A-01 an exact or keyed hit in a later paragraph beats a fuzzy match in an earlier one", () => {
  const p1 = "去了市场买许多蔬果。";
  const p2 = "他昨天去了市场买许多蔬果和水果。";
  const text = `${p1}\n${p2}`;
  const paras = [
    { id: "p1", start: 0, end: p1.length },
    { id: "p2", start: p1.length + 1, end: text.length },
  ];
  const quote = "昨天去了市场买许多蔬果";

  // p1's sentence would fuzzy-match the quote; the keyed pass finds the quote
  // inside p2 first, so the exact hit wins regardless of paragraph order.
  const hit = locateQuote(text, paras, quote);
  assert.equal(hit.located, "exact");
  assert.equal(hit.para, "p2");
  assert.equal(hit.start, p1.length + 2);
  assert.equal(hit.end, p1.length + 2 + quote.length);
  assert.equal(hit.text, quote);
});
