// Pure zero-dependency paragraph-level LCS diff engine for manuscript comparison.

export type DiffRowKind = "equal" | "added" | "removed" | "changed";

export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly leftIndex: number | null;
  readonly rightIndex: number | null;
  readonly leftText: string;
  readonly rightText: string;
}

export interface DiffSummary {
  readonly rows: readonly DiffRow[];
  readonly unchanged: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

function splitParagraphs(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Computes a readable paragraph-level diff between original manuscript and
 * candidate text, pairing adjacent remove+add blocks as `changed` rows for
 * clean side-by-side and inline editorial review.
 */
export function computeParagraphDiff(original: string, candidate: string): DiffSummary {
  const left = splitParagraphs(original);
  const right = splitParagraphs(candidate);

  // Guard quadratic memory on extreme paragraph counts by falling back to prefix/suffix pairing.
  const maxMatrixCells = 160_000;
  let ops: { type: "equal" | "removed" | "added"; leftIndex?: number; rightIndex?: number }[] = [];

  if (left.length * right.length <= maxMatrixCells) {
    const m = left.length;
    const n = right.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (left[i] === right[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const across = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= across ? down : across;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (left[i] === right[j]) {
        ops.push({ type: "equal", leftIndex: i, rightIndex: j });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        ops.push({ type: "removed", leftIndex: i });
        i++;
      } else {
        ops.push({ type: "added", rightIndex: j });
        j++;
      }
    }
    while (i < m) ops.push({ type: "removed", leftIndex: i++ });
    while (j < n) ops.push({ type: "added", rightIndex: j++ });
  } else {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
      ops.push({ type: "equal", leftIndex: prefix, rightIndex: prefix });
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < left.length - prefix &&
      suffix < right.length - prefix &&
      left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
    ) {
      suffix++;
    }
    for (let i = prefix; i < left.length - suffix; i++) ops.push({ type: "removed", leftIndex: i });
    for (let j = prefix; j < right.length - suffix; j++) ops.push({ type: "added", rightIndex: j });
    for (let k = suffix - 1; k >= 0; k--) {
      ops.push({ type: "equal", leftIndex: left.length - 1 - k, rightIndex: right.length - 1 - k });
    }
  }

  // Collapse contiguous removed + added runs into paired `changed` rows.
  const rows: DiffRow[] = [];
  let idx = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let changed = 0;

  while (idx < ops.length) {
    const current = ops[idx];
    if (current.type === "equal") {
      const li = current.leftIndex!;
      const ri = current.rightIndex!;
      rows.push({ kind: "equal", leftIndex: li + 1, rightIndex: ri + 1, leftText: left[li], rightText: right[ri] });
      unchanged++;
      idx++;
      continue;
    }

    const removedBatch: number[] = [];
    const addedBatch: number[] = [];
    while (idx < ops.length && ops[idx].type !== "equal") {
      if (ops[idx].type === "removed") removedBatch.push(ops[idx].leftIndex!);
      else addedBatch.push(ops[idx].rightIndex!);
      idx++;
    }

    const paired = Math.min(removedBatch.length, addedBatch.length);
    for (let k = 0; k < paired; k++) {
      const li = removedBatch[k];
      const ri = addedBatch[k];
      rows.push({ kind: "changed", leftIndex: li + 1, rightIndex: ri + 1, leftText: left[li], rightText: right[ri] });
      changed++;
    }
    for (let k = paired; k < removedBatch.length; k++) {
      const li = removedBatch[k];
      rows.push({ kind: "removed", leftIndex: li + 1, rightIndex: null, leftText: left[li], rightText: "" });
      removed++;
    }
    for (let k = paired; k < addedBatch.length; k++) {
      const ri = addedBatch[k];
      rows.push({ kind: "added", leftIndex: null, rightIndex: ri + 1, leftText: "", rightText: right[ri] });
      added++;
    }
  }

  return { rows, unchanged, added, removed, changed };
}
