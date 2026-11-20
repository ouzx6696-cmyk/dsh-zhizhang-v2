export type DiffRowKind = "equal" | "added" | "removed" | "changed";

export interface ParagraphDiffRow {
  readonly kind: DiffRowKind;
  readonly leftIndex: number | null;
  readonly rightIndex: number | null;
  readonly leftText: string;
  readonly rightText: string;
}

export interface ParagraphDiffSummary {
  readonly rows: readonly ParagraphDiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly lineEnding?: "\r\n" | "\n";
}

export interface InlineDiffSegment {
  readonly kind: "equal" | "removed" | "added";
  readonly text: string;
}

type SeqOp =
  | { readonly kind: "equal"; readonly li: number; readonly ri: number }
  | { readonly kind: "removed"; readonly li: number }
  | { readonly kind: "added"; readonly ri: number };

const MAX_MYERS_D = 2000;
const SENTENCE_END_CHARS = new Set(["。", "！", "？", "…", "；", "!", "?", ";"]);
const SENTENCE_CLOSERS = new Set(["”", "’", "」", "』", "》", "）", "】", "\"", "'", ")", "]", " ", "\t"]);

/** Counts Unicode code points (matches backend TITLE_MAX semantics). */
export function countUnicodeCodePoints(value: string): number {
  return [...value.trim()].length;
}

/** Counts non-whitespace Unicode characters (matches chapter/article length semantics). */
export function countNonWhitespaceChars(value: string): number {
  return [...value.replace(/\s/gu, "")].length;
}

/** Detects whether a manuscript predominantly uses CRLF (`\r\n`) or LF (`\n`). */
export function detectLineEnding(text: string): "\r\n" | "\n" {
  if (!text.includes("\r\n")) return "\n";
  let crlf = 0;
  let lfOnly = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      if (i > 0 && text[i - 1] === "\r") crlf++;
      else lfOnly++;
    }
  }
  return crlf > 0 && crlf >= lfOnly ? "\r\n" : "\n";
}

/** Tokenizes CJK text per code point while keeping ASCII words & whitespace runs intact. */
export function tokenizeForInlineDiff(text: string): string[] {
  if (!text) return [];
  return text.match(/[A-Za-z0-9_]+|\s+|[\u{10000}-\u{10FFFF}]|./gu) ?? [];
}

/**
 * Losslessly splits a paragraph into sentences on CJK/ASCII terminal punctuation
 * (`。！？…；!?;`) plus immediately following closing quotes/brackets/spaces so
 * sentence-level LCS narrows inline diffing on long Chinese paragraphs.
 */
export function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const chars = [...text];
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < chars.length) {
    if (SENTENCE_END_CHARS.has(chars[i])) {
      while (i + 1 < chars.length && SENTENCE_END_CHARS.has(chars[i + 1])) i++;
      while (i + 1 < chars.length && SENTENCE_CLOSERS.has(chars[i + 1])) i++;
      sentences.push(chars.slice(start, i + 1).join(""));
      start = i + 1;
    }
    i++;
  }
  if (start < chars.length) {
    sentences.push(chars.slice(start).join(""));
  }
  return sentences;
}

/**
 * Exact bounded Myers O(ND) shortest-edit-script diff over array slices.
 * Returns `null` if the edit distance exceeds `maxD`, allowing callers to degrade cleanly.
 */
function myersDiffRange(
  left: readonly string[],
  l0: number,
  l1: number,
  right: readonly string[],
  r0: number,
  r1: number,
  maxD: number,
): SeqOp[] | null {
  let prefix = 0;
  while (l0 + prefix < l1 && r0 + prefix < r1 && left[l0 + prefix] === right[r0 + prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    l0 + prefix + suffix < l1 &&
    r0 + prefix + suffix < r1 &&
    left[l1 - 1 - suffix] === right[r1 - 1 - suffix]
  ) {
    suffix++;
  }

  const aStart = l0 + prefix;
  const aLen = l1 - suffix - aStart;
  const bStart = r0 + prefix;
  const bLen = r1 - suffix - bStart;

  const ops: SeqOp[] = [];
  for (let p = 0; p < prefix; p++) {
    ops.push({ kind: "equal", li: l0 + p, ri: r0 + p });
  }

  if (aLen === 0 || bLen === 0) {
    for (let i = 0; i < aLen; i++) ops.push({ kind: "removed", li: aStart + i });
    for (let j = 0; j < bLen; j++) ops.push({ kind: "added", ri: bStart + j });
    for (let s = suffix - 1; s >= 0; s--) {
      ops.push({ kind: "equal", li: l1 - 1 - s, ri: r1 - 1 - s });
    }
    return ops;
  }

  const dLimit = Math.min(maxD, aLen + bLen);
  const trace: Int32Array[] = [];

  // d = 0 (prefix already stripped, so snake stops at (0, 0))
  trace.push(Int32Array.of(0));
  let finalD = -1;

  for (let d = 1; d <= dLimit; d++) {
    const prev = trace[d - 1];
    const curr = new Int32Array(2 * d + 1);
    curr.fill(-1);
    for (let k = -d; k <= d; k += 2) {
      const downPx = k !== d ? prev[k + 1 + (d - 1)] : -1;
      const downX = downPx >= 0 && downPx <= aLen && downPx - k <= bLen ? downPx : -1;
      const rightPx = k !== -d ? prev[k - 1 + (d - 1)] : -1;
      const rightX = rightPx >= 0 && rightPx + 1 <= aLen && rightPx + 1 - k <= bLen ? rightPx + 1 : -1;
      if (downX === -1 && rightX === -1) continue;

      let x = downX >= rightX ? downX : rightX;
      let y = x - k;
      while (x < aLen && y < bLen && left[aStart + x] === right[bStart + y]) {
        x++;
        y++;
      }
      curr[k + d] = x;
      if (x === aLen && y === bLen) {
        finalD = d;
        break;
      }
    }
    trace.push(curr);
    if (finalD !== -1) break;
  }

  if (finalD === -1) {
    return null;
  }

  const midReversed: SeqOp[] = [];
  let x = aLen;
  let y = bLen;
  for (let d = finalD; d >= 1; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const downPx = k !== d ? prev[k + 1 + (d - 1)] : -1;
    const downX = downPx >= 0 && downPx <= aLen && downPx - k <= bLen ? downPx : -1;
    const rightPx = k !== -d ? prev[k - 1 + (d - 1)] : -1;
    const rightX = rightPx >= 0 && rightPx + 1 <= aLen && rightPx + 1 - k <= bLen ? rightPx + 1 : -1;
    const useDown = downX >= rightX;
    const prevK = useDown ? k + 1 : k - 1;
    const prevX = prev[prevK + (d - 1)];
    const prevY = prevX - prevK;
    const editX = useDown ? prevX : prevX + 1;
    const editY = useDown ? prevY + 1 : prevY;

    while (x > editX && y > editY) {
      x--;
      y--;
      midReversed.push({ kind: "equal", li: aStart + x, ri: bStart + y });
    }
    if (useDown) {
      midReversed.push({ kind: "added", ri: bStart + prevY });
    } else {
      midReversed.push({ kind: "removed", li: aStart + prevX });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    midReversed.push({ kind: "equal", li: aStart + x, ri: bStart + y });
  }

  for (let idx = midReversed.length - 1; idx >= 0; idx--) {
    ops.push(midReversed[idx]);
  }
  for (let s = suffix - 1; s >= 0; s--) {
    ops.push({ kind: "equal", li: l1 - 1 - s, ri: r1 - 1 - s });
  }
  return ops;
}

function pushInlineSegment(out: InlineDiffSegment[], kind: InlineDiffSegment["kind"], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    out[out.length - 1] = { kind, text: last.text + text };
  } else {
    out.push({ kind, text });
  }
}

function diffTokensInto(before: string, after: string, out: InlineDiffSegment[]): void {
  if (before === after) {
    pushInlineSegment(out, "equal", before);
    return;
  }
  if (!before) {
    pushInlineSegment(out, "added", after);
    return;
  }
  if (!after) {
    pushInlineSegment(out, "removed", before);
    return;
  }

  const left = tokenizeForInlineDiff(before);
  const right = tokenizeForInlineDiff(after);
  const ops = myersDiffRange(left, 0, left.length, right, 0, right.length, MAX_MYERS_D);
  if (ops) {
    for (const op of ops) {
      if (op.kind === "equal") pushInlineSegment(out, "equal", left[op.li]);
      else if (op.kind === "removed") pushInlineSegment(out, "removed", left[op.li]);
      else pushInlineSegment(out, "added", right[op.ri]);
    }
    return;
  }

  // Fallback when edit distance exceeds MAX_MYERS_D: preserve common prefix & suffix.
  const m = left.length;
  const n = right.length;
  let prefix = 0;
  while (prefix < m && prefix < n && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < m - prefix && suffix < n - prefix && left[m - 1 - suffix] === right[n - 1 - suffix]) suffix++;
  if (prefix > 0) pushInlineSegment(out, "equal", left.slice(0, prefix).join(""));
  if (prefix + suffix < m) pushInlineSegment(out, "removed", left.slice(prefix, m - suffix).join(""));
  if (prefix + suffix < n) pushInlineSegment(out, "added", right.slice(prefix, n - suffix).join(""));
  if (suffix > 0) pushInlineSegment(out, "equal", left.slice(m - suffix).join(""));
}

/**
 * Computes character/word-level inline diff segments inside a changed paragraph
 * or selected rewrite fragment: splits into sentences on CJK/ASCII punctuation
 * first, aligns sentences via Myers O(ND), then diffs changed sentence spans at
 * token level (Myers O(ND), D <= 2000 guard), merging contiguous same-kind runs.
 */
export function computeInlineDiff(before: string, after: string): InlineDiffSegment[] {
  if (before === after) return before ? [{ kind: "equal", text: before }] : [];
  if (!before) return [{ kind: "added", text: after }];
  if (!after) return [{ kind: "removed", text: before }];

  const out: InlineDiffSegment[] = [];
  const leftSents = splitIntoSentences(before);
  const rightSents = splitIntoSentences(after);

  if (leftSents.length > 1 || rightSents.length > 1) {
    const sentOps = myersDiffRange(leftSents, 0, leftSents.length, rightSents, 0, rightSents.length, MAX_MYERS_D);
    if (sentOps) {
      let cursor = 0;
      while (cursor < sentOps.length) {
        const current = sentOps[cursor];
        if (current.kind === "equal") {
          pushInlineSegment(out, "equal", leftSents[current.li]);
          cursor++;
          continue;
        }
        const remSents: string[] = [];
        const addSents: string[] = [];
        while (cursor < sentOps.length && sentOps[cursor].kind !== "equal") {
          const op = sentOps[cursor];
          if (op.kind === "removed") remSents.push(leftSents[op.li]);
          else if (op.kind === "added") addSents.push(rightSents[op.ri]);
          cursor++;
        }
        if (remSents.length === 0) {
          pushInlineSegment(out, "added", addSents.join(""));
        } else if (addSents.length === 0) {
          pushInlineSegment(out, "removed", remSents.join(""));
        } else {
          const remJoined = remSents.join("");
          const addJoined = addSents.join("");
          if (remJoined.length + addJoined.length <= 2400) {
            diffTokensInto(remJoined, addJoined, out);
          } else {
            const paired = Math.min(remSents.length, addSents.length);
            for (let k = 0; k < paired; k++) {
              diffTokensInto(remSents[k], addSents[k], out);
            }
            for (let k = paired; k < remSents.length; k++) {
              pushInlineSegment(out, "removed", remSents[k]);
            }
            for (let k = paired; k < addSents.length; k++) {
              pushInlineSegment(out, "added", addSents[k]);
            }
          }
        }
      }
      return out;
    }
  }

  diffTokensInto(before, after, out);
  return out;
}

function isBlankRow(row: ParagraphDiffRow): boolean {
  return row.leftText.trim() === "" && row.rightText.trim() === "";
}

/**
 * Produces the merged chapter body by keeping selected `changed`/`added`/`removed`
 * hunk row indices (`0`-based in `diff.rows`) and rejecting unselected hunks.
 * Preserves blank-line spacers attached to adjacent hunks and restores the
 * original manuscript's line ending (`\r\n` vs `\n`) per FE-13.
 */
export function mergeParagraphSelections(
  diff: ParagraphDiffSummary,
  adoptedRowIndices: ReadonlySet<number>,
): string {
  const rows = diff.rows;
  let nonBlankHunkCount = 0;
  let adoptedNonBlankCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== "equal" && !isBlankRow(row)) {
      nonBlankHunkCount++;
      if (adoptedRowIndices.has(i)) adoptedNonBlankCount++;
    }
  }
  const allNonBlankHunksAdopted = nonBlankHunkCount > 0 && adoptedNonBlankCount === nonBlankHunkCount;

  const isBlankSpacerAdopted = (idx: number): boolean => {
    if (adoptedRowIndices.has(idx)) return true;

    let prevNonBlank = idx - 1;
    while (prevNonBlank >= 0 && isBlankRow(rows[prevNonBlank])) prevNonBlank--;
    let nextNonBlank = idx + 1;
    while (nextNonBlank < rows.length && isBlankRow(rows[nextNonBlank])) nextNonBlank++;

    const prevIsHunk = prevNonBlank >= 0 && rows[prevNonBlank].kind !== "equal";
    const nextIsHunk = nextNonBlank < rows.length && rows[nextNonBlank].kind !== "equal";

    if (prevIsHunk || nextIsHunk) {
      return (prevIsHunk && adoptedRowIndices.has(prevNonBlank)) || (nextIsHunk && adoptedRowIndices.has(nextNonBlank));
    }
    return allNonBlankHunksAdopted;
  };

  const output: string[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (row.kind === "equal") {
      output.push(row.leftText);
    } else if (row.kind === "changed") {
      output.push(adoptedRowIndices.has(idx) ? row.rightText : row.leftText);
    } else if (row.kind === "added") {
      const keep = isBlankRow(row) ? isBlankSpacerAdopted(idx) : adoptedRowIndices.has(idx);
      if (keep) output.push(row.rightText);
    } else if (row.kind === "removed") {
      const remove = isBlankRow(row) ? isBlankSpacerAdopted(idx) : adoptedRowIndices.has(idx);
      if (!remove) output.push(row.leftText);
    }
  }
  return output.join(diff.lineEnding ?? "\n");
}

function splitParagraphs(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Finds Longest Increasing Subsequence of unique non-blank matching lines
 * (Patience diff anchors) in O(N log N) time.
 */
function findPatienceAnchors(
  left: readonly string[],
  l0: number,
  l1: number,
  right: readonly string[],
  r0: number,
  r1: number,
): Array<{ readonly li: number; readonly ri: number }> {
  const leftCounts = new Map<string, number>();
  const leftPos = new Map<string, number>();
  for (let i = l0; i < l1; i++) {
    const line = left[i];
    if (line.trim() === "") continue;
    const count = (leftCounts.get(line) ?? 0) + 1;
    leftCounts.set(line, count);
    if (count === 1) leftPos.set(line, i);
  }

  const rightCounts = new Map<string, number>();
  const rightPos = new Map<string, number>();
  for (let j = r0; j < r1; j++) {
    const line = right[j];
    if (line.trim() === "" || leftCounts.get(line) !== 1) continue;
    const count = (rightCounts.get(line) ?? 0) + 1;
    rightCounts.set(line, count);
    if (count === 1) rightPos.set(line, j);
  }

  const pairs: Array<{ readonly li: number; readonly ri: number }> = [];
  for (let i = l0; i < l1; i++) {
    const line = left[i];
    if (leftCounts.get(line) === 1 && rightCounts.get(line) === 1) {
      pairs.push({ li: i, ri: rightPos.get(line)! });
    }
  }
  if (pairs.length === 0) return [];

  // Patience sorting LIS on pairs[k].ri
  const tailIndices: number[] = [];
  const prevLink = new Int32Array(pairs.length);
  prevLink.fill(-1);

  for (let k = 0; k < pairs.length; k++) {
    const targetRi = pairs[k].ri;
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tailIndices[mid]].ri < targetRi) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevLink[k] = tailIndices[lo - 1];
    tailIndices[lo] = k;
  }

  const lis: Array<{ readonly li: number; readonly ri: number }> = [];
  let curr = tailIndices.length > 0 ? tailIndices[tailIndices.length - 1] : -1;
  while (curr !== -1) {
    lis.push(pairs[curr]);
    curr = prevLink[curr];
  }
  lis.reverse();
  return lis;
}

function diffParagraphRange(
  left: readonly string[],
  l0: number,
  l1: number,
  right: readonly string[],
  r0: number,
  r1: number,
  out: SeqOp[],
  depth = 0,
): void {
  let prefix = 0;
  while (l0 + prefix < l1 && r0 + prefix < r1 && left[l0 + prefix] === right[r0 + prefix]) {
    out.push({ kind: "equal", li: l0 + prefix, ri: r0 + prefix });
    prefix++;
  }
  let suffix = 0;
  while (
    l0 + prefix + suffix < l1 &&
    r0 + prefix + suffix < r1 &&
    left[l1 - 1 - suffix] === right[r1 - 1 - suffix]
  ) {
    suffix++;
  }

  const aStart = l0 + prefix;
  const aEnd = l1 - suffix;
  const bStart = r0 + prefix;
  const bEnd = r1 - suffix;

  if (aStart === aEnd) {
    for (let j = bStart; j < bEnd; j++) out.push({ kind: "added", ri: j });
  } else if (bStart === bEnd) {
    for (let i = aStart; i < aEnd; i++) out.push({ kind: "removed", li: i });
  } else {
    const anchors = depth < 6 ? findPatienceAnchors(left, aStart, aEnd, right, bStart, bEnd) : [];
    if (anchors.length > 0) {
      let curL = aStart;
      let curR = bStart;
      for (const anchor of anchors) {
        if (curL < anchor.li || curR < anchor.ri) {
          diffParagraphRange(left, curL, anchor.li, right, curR, anchor.ri, out, depth + 1);
        }
        out.push({ kind: "equal", li: anchor.li, ri: anchor.ri });
        curL = anchor.li + 1;
        curR = anchor.ri + 1;
      }
      if (curL < aEnd || curR < bEnd) {
        diffParagraphRange(left, curL, aEnd, right, curR, bEnd, out, depth + 1);
      }
    } else {
      const myers = myersDiffRange(left, aStart, aEnd, right, bStart, bEnd, MAX_MYERS_D);
      if (myers) {
        for (const op of myers) out.push(op);
      } else {
        // Extreme un-anchored divergence (>2000 edits): deterministic linear pairing fallback.
        const span = Math.max(aEnd - aStart, bEnd - bStart);
        for (let k = 0; k < span; k++) {
          const li = aStart + k;
          const ri = bStart + k;
          if (li < aEnd && ri < bEnd) {
            if (left[li] === right[ri]) {
              out.push({ kind: "equal", li, ri });
            } else {
              out.push({ kind: "removed", li });
              out.push({ kind: "added", ri });
            }
          } else if (li < aEnd) {
            out.push({ kind: "removed", li });
          } else {
            out.push({ kind: "added", ri });
          }
        }
      }
    }
  }

  for (let s = suffix - 1; s >= 0; s--) {
    out.push({ kind: "equal", li: l1 - 1 - s, ri: r1 - 1 - s });
  }
}

/**
 * Computes a clean, deterministic paragraph-level diff between an original
 * manuscript and a candidate body using Patience unique-anchor splitting plus
 * bounded Myers O(ND). Pairs adjacent deletions + insertions into `changed`
 * rows so side-by-side comparison aligns modified paragraphs.
 */
export function computeParagraphDiff(original: string, candidate: string): ParagraphDiffSummary {
  const lineEnding = detectLineEnding(original);
  const left = splitParagraphs(original);
  const right = splitParagraphs(candidate);

  const ops: SeqOp[] = [];
  diffParagraphRange(left, 0, left.length, right, 0, right.length, ops);

  const rows: ParagraphDiffRow[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  let cursor = 0;
  while (cursor < ops.length) {
    const current = ops[cursor];
    if (current.kind === "equal") {
      rows.push({
        kind: "equal",
        leftIndex: current.li + 1,
        rightIndex: current.ri + 1,
        leftText: left[current.li],
        rightText: right[current.ri],
      });
      unchanged++;
      cursor++;
      continue;
    }

    const removedBatch: number[] = [];
    const addedBatch: number[] = [];
    while (cursor < ops.length && ops[cursor].kind !== "equal") {
      const op = ops[cursor];
      if (op.kind === "removed") removedBatch.push(op.li);
      else if (op.kind === "added") addedBatch.push(op.ri);
      cursor++;
    }

    let ri = 0;
    let ai = 0;
    while (ri < removedBatch.length || ai < addedBatch.length) {
      const hasRem = ri < removedBatch.length;
      const hasAdd = ai < addedBatch.length;
      const remBlank = hasRem && left[removedBatch[ri]].trim() === "";
      const addBlank = hasAdd && right[addedBatch[ai]].trim() === "";

      if (hasRem && remBlank && (!hasAdd || !addBlank)) {
        rows.push({
          kind: "removed",
          leftIndex: removedBatch[ri] + 1,
          rightIndex: null,
          leftText: left[removedBatch[ri]],
          rightText: "",
        });
        removed++;
        ri++;
      } else if (hasAdd && addBlank && (!hasRem || !remBlank)) {
        rows.push({
          kind: "added",
          leftIndex: null,
          rightIndex: addedBatch[ai] + 1,
          leftText: "",
          rightText: right[addedBatch[ai]],
        });
        added++;
        ai++;
      } else if (hasRem && hasAdd) {
        rows.push({
          kind: "changed",
          leftIndex: removedBatch[ri] + 1,
          rightIndex: addedBatch[ai] + 1,
          leftText: left[removedBatch[ri]],
          rightText: right[addedBatch[ai]],
        });
        changed++;
        ri++;
        ai++;
      } else if (hasRem) {
        rows.push({
          kind: "removed",
          leftIndex: removedBatch[ri] + 1,
          rightIndex: null,
          leftText: left[removedBatch[ri]],
          rightText: "",
        });
        removed++;
        ri++;
      } else {
        rows.push({
          kind: "added",
          leftIndex: null,
          rightIndex: addedBatch[ai] + 1,
          leftText: "",
          rightText: right[addedBatch[ai]],
        });
        added++;
        ai++;
      }
    }
  }

  return { rows, added, removed, changed, unchanged, lineEnding };
}
