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
}

export interface InlineDiffSegment {
  readonly kind: "equal" | "removed" | "added";
  readonly text: string;
}

/** Counts Unicode code points (matches backend TITLE_MAX semantics). */
export function countUnicodeCodePoints(value: string): number {
  return [...value.trim()].length;
}

/** Counts non-whitespace Unicode characters (matches chapter/article length semantics). */
export function countNonWhitespaceChars(value: string): number {
  return [...value.replace(/\s/gu, "")].length;
}

/** Tokenizes CJK text per code point while keeping ASCII words & whitespace runs intact. */
export function tokenizeForInlineDiff(text: string): string[] {
  if (!text) return [];
  return text.match(/[A-Za-z0-9_]+|\s+|[\u{10000}-\u{10FFFF}]|./gu) ?? [];
}

/**
 * Computes character/word-level inline LCS diff segments inside a changed
 * paragraph or selected rewrite fragment, merging contiguous same-kind segments.
 */
export function computeInlineDiff(before: string, after: string): InlineDiffSegment[] {
  const left = tokenizeForInlineDiff(before);
  const right = tokenizeForInlineDiff(after);
  const m = left.length;
  const n = right.length;
  const raw: InlineDiffSegment[] = [];

  if (m * n > 80_000) {
    let prefix = 0;
    while (prefix < m && prefix < n && left[prefix] === right[prefix]) prefix++;
    let suffix = 0;
    while (suffix < m - prefix && suffix < n - prefix && left[m - 1 - suffix] === right[n - 1 - suffix]) suffix++;
    if (prefix > 0) raw.push({ kind: "equal", text: left.slice(0, prefix).join("") });
    if (prefix + suffix < m) raw.push({ kind: "removed", text: left.slice(prefix, m - suffix).join("") });
    if (prefix + suffix < n) raw.push({ kind: "added", text: right.slice(prefix, n - suffix).join("") });
    if (suffix > 0) raw.push({ kind: "equal", text: left.slice(m - suffix).join("") });
    return raw;
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (left[i] === right[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
    }
  }

  let i = 0;
  let j = 0;
  const pushSeg = (kind: InlineDiffSegment["kind"], text: string) => {
    const last = raw[raw.length - 1];
    if (last && last.kind === kind) raw[raw.length - 1] = { kind, text: last.text + text };
    else raw.push({ kind, text });
  };
  while (i < m && j < n) {
    if (left[i] === right[j]) {
      pushSeg("equal", left[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg("removed", left[i]);
      i++;
    } else {
      pushSeg("added", right[j]);
      j++;
    }
  }
  while (i < m) {
    pushSeg("removed", left[i]);
    i++;
  }
  while (j < n) {
    pushSeg("added", right[j]);
    j++;
  }
  return raw;
}

/**
 * Produces the merged chapter body by keeping selected `changed`/`added`/`removed`
 * hunk row indices (`0`-based in `diff.rows`) and rejecting unselected hunks.
 */
export function mergeParagraphSelections(
  diff: ParagraphDiffSummary,
  adoptedRowIndices: ReadonlySet<number>,
): string {
  const output: string[] = [];
  diff.rows.forEach((row, idx) => {
    if (row.kind === "equal") {
      output.push(row.leftText);
    } else if (row.kind === "changed") {
      output.push(adoptedRowIndices.has(idx) ? row.rightText : row.leftText);
    } else if (row.kind === "added") {
      if (adoptedRowIndices.has(idx)) output.push(row.rightText);
    } else if (row.kind === "removed") {
      if (!adoptedRowIndices.has(idx)) output.push(row.leftText);
    }
  });
  return output.join("\n");
}

function splitParagraphs(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Computes a clean, deterministic paragraph-level LCS diff between an original
 * manuscript and a candidate body. Pairs adjacent deletions + insertions into
 * `changed` rows so side-by-side comparison aligns modified paragraphs.
 */
export function computeParagraphDiff(original: string, candidate: string): ParagraphDiffSummary {
  const left = splitParagraphs(original);
  const right = splitParagraphs(candidate);
  const m = left.length;
  const n = right.length;

  // Guard against pathological paragraph counts by falling back to linear pairing.
  const ops: Array<{ kind: "equal" | "removed" | "added"; li: number | null; ri: number | null }> = [];
  if (m * n > 250_000) {
    const limit = Math.max(m, n);
    for (let i = 0; i < limit; i++) {
      if (i < m && i < n) {
        if (left[i] === right[i]) ops.push({ kind: "equal", li: i, ri: i });
        else {
          ops.push({ kind: "removed", li: i, ri: null });
          ops.push({ kind: "added", li: null, ri: i });
        }
      } else if (i < m) {
        ops.push({ kind: "removed", li: i, ri: null });
      } else {
        ops.push({ kind: "added", li: null, ri: i });
      }
    }
  } else {
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (left[i] === right[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (left[i] === right[j]) {
        ops.push({ kind: "equal", li: i, ri: j });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: "removed", li: i, ri: null });
        i++;
      } else {
        ops.push({ kind: "added", li: null, ri: j });
        j++;
      }
    }
    while (i < m) {
      ops.push({ kind: "removed", li: i, ri: null });
      i++;
    }
    while (j < n) {
      ops.push({ kind: "added", li: null, ri: j });
      j++;
    }
  }

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
        leftIndex: current.li! + 1,
        rightIndex: current.ri! + 1,
        leftText: left[current.li!],
        rightText: right[current.ri!],
      });
      unchanged++;
      cursor++;
      continue;
    }

    const removedBatch: number[] = [];
    const addedBatch: number[] = [];
    while (cursor < ops.length && ops[cursor].kind !== "equal") {
      if (ops[cursor].kind === "removed") removedBatch.push(ops[cursor].li!);
      else addedBatch.push(ops[cursor].ri!);
      cursor++;
    }
    const paired = Math.min(removedBatch.length, addedBatch.length);
    for (let k = 0; k < paired; k++) {
      rows.push({
        kind: "changed",
        leftIndex: removedBatch[k] + 1,
        rightIndex: addedBatch[k] + 1,
        leftText: left[removedBatch[k]],
        rightText: right[addedBatch[k]],
      });
      changed++;
    }
    for (let k = paired; k < removedBatch.length; k++) {
      rows.push({
        kind: "removed",
        leftIndex: removedBatch[k] + 1,
        rightIndex: null,
        leftText: left[removedBatch[k]],
        rightText: "",
      });
      removed++;
    }
    for (let k = paired; k < addedBatch.length; k++) {
      rows.push({
        kind: "added",
        leftIndex: null,
        rightIndex: addedBatch[k] + 1,
        leftText: "",
        rightText: right[addedBatch[k]],
      });
      added++;
    }
  }

  return { rows, added, removed, changed, unchanged };
}
