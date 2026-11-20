import { ContractError } from "../../contracts/errors.ts";

export interface HierarchyVolume {
  readonly id: string;
  readonly sortOrder: number;
}

export interface HierarchyAct {
  readonly id: string;
  readonly volumeId: string;
  readonly sortOrder: number;
}

export interface HierarchyChapter {
  readonly id: string;
  readonly volumeId: string | null;
  readonly actId: string | null;
}

export interface ChapterMoveSpec {
  readonly chapterId: string;
  readonly targetVolumeId: string | null;
  readonly targetActId: string | null;
  readonly beforeChapterId?: string | null;
  readonly targetIndex?: number;
}

/**
 * Deterministically flattens a 3-tier Volume -> Act -> Chapter tree into a
 * 1D narrative chapter order compatible with `author_chapter_order` and `settingsAt`.
 */
export function flattenNovelOrder(
  volumes: readonly HierarchyVolume[],
  acts: readonly HierarchyAct[],
  chapters: readonly HierarchyChapter[],
  currentOrder: readonly string[],
): string[] {
  const rank = new Map<string, number>();
  currentOrder.forEach((id, idx) => {
    if (!rank.has(id)) rank.set(id, idx);
  });
  const byCurrentRank = (left: { readonly id: string }, right: { readonly id: string }) =>
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER);

  const sortedVolumes = [...volumes].sort((a, b) => a.sortOrder - b.sortOrder);
  const actsByVolume = new Map<string, HierarchyAct[]>();
  for (const act of [...acts].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const bucket = actsByVolume.get(act.volumeId);
    if (bucket) bucket.push(act);
    else actsByVolume.set(act.volumeId, [act]);
  }

  // Pre-bucket chapters once in O(C) to avoid O((V + A) * C) filtering at 5,000-chapter scale (FQ-18).
  const chaptersByAct = new Map<string, HierarchyChapter[]>();
  const directChaptersByVolume = new Map<string, HierarchyChapter[]>();
  for (const ch of chapters) {
    if (ch.volumeId !== null && ch.actId !== null) {
      const key = `${ch.volumeId}\0${ch.actId}`;
      const bucket = chaptersByAct.get(key);
      if (bucket) bucket.push(ch);
      else chaptersByAct.set(key, [ch]);
    } else if (ch.volumeId !== null && !ch.actId) {
      const bucket = directChaptersByVolume.get(ch.volumeId);
      if (bucket) bucket.push(ch);
      else directChaptersByVolume.set(ch.volumeId, [ch]);
    }
  }

  const assigned = new Set<string>();
  const result: string[] = [];

  for (const volume of sortedVolumes) {
    const volumeActs = actsByVolume.get(volume.id) ?? [];
    for (const act of volumeActs) {
      const actChapters = (chaptersByAct.get(`${volume.id}\0${act.id}`) ?? []).sort(byCurrentRank);
      for (const ch of actChapters) {
        if (!assigned.has(ch.id)) {
          assigned.add(ch.id);
          result.push(ch.id);
        }
      }
    }
    // Chapters placed directly inside a volume without an act come after its acts.
    const directVolumeChapters = (directChaptersByVolume.get(volume.id) ?? []).sort(byCurrentRank);
    for (const ch of directVolumeChapters) {
      if (!assigned.has(ch.id)) {
        assigned.add(ch.id);
        result.push(ch.id);
      }
    }
  }

  const ungrouped = chapters.filter((ch) => !assigned.has(ch.id)).sort(byCurrentRank);
  for (const ch of ungrouped) result.push(ch.id);
  return result;
}

/**
 * Computes the proposed 1D chapter order when moving a chapter across volumes,
 * acts, or positions so `planReorder()` can verify temporal flips before commit.
 */
export function planTreeChapterMove(
  volumes: readonly HierarchyVolume[],
  acts: readonly HierarchyAct[],
  chapters: readonly HierarchyChapter[],
  currentOrder: readonly string[],
  spec: ChapterMoveSpec,
): { readonly beforeOrder: string[]; readonly afterOrder: string[] } {
  const targetChapter = chapters.find((ch) => ch.id === spec.chapterId);
  if (!targetChapter) {
    throw new ContractError("input.not_found", { objectType: "document", objectId: spec.chapterId });
  }
  if (spec.targetVolumeId !== null && !volumes.some((vol) => vol.id === spec.targetVolumeId)) {
    throw new ContractError("input.not_found", { objectType: "volume", objectId: spec.targetVolumeId });
  }
  if (spec.targetActId !== null) {
    const act = acts.find((entry) => entry.id === spec.targetActId);
    if (!act) {
      throw new ContractError("input.not_found", { objectType: "act", objectId: spec.targetActId });
    }
    if (spec.targetVolumeId !== null && act.volumeId !== spec.targetVolumeId) {
      throw new ContractError("input.invalid", { field: "targetActId", reason: "act-volume-mismatch" });
    }
  }

  const beforeOrder = currentOrder.length === chapters.length
    ? [...currentOrder]
    : flattenNovelOrder(volumes, acts, chapters, currentOrder);

  const resolvedVolumeId = spec.targetActId !== null && spec.targetVolumeId === null
    ? acts.find((entry) => entry.id === spec.targetActId)!.volumeId
    : spec.targetVolumeId;

  const updatedChapters = chapters.map((ch) =>
    ch.id === spec.chapterId
      ? { ...ch, volumeId: resolvedVolumeId, actId: spec.targetActId }
      : ch,
  );
  const beforePos = new Map<string, number>();
  beforeOrder.forEach((id, index) => {
    if (!beforePos.has(id)) beforePos.set(id, index);
  });
  const withoutMoved = beforeOrder.filter((id) => id !== spec.chapterId);
  const matchingSiblings = updatedChapters
    .filter((ch) => ch.id !== spec.chapterId && ch.volumeId === resolvedVolumeId && ch.actId === spec.targetActId)
    .map((ch) => ch.id)
    .sort(
      (left, right) =>
        (beforePos.get(left) ?? Number.MAX_SAFE_INTEGER) - (beforePos.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  let insertPos = withoutMoved.length;
  if (spec.beforeChapterId) {
    const beforeIdx = withoutMoved.indexOf(spec.beforeChapterId);
    if (beforeIdx === -1) {
      throw new ContractError("input.not_found", { objectType: "document", objectId: spec.beforeChapterId });
    }
    insertPos = beforeIdx;
  } else if (spec.targetIndex !== undefined) {
    const clamped = Math.max(0, Math.min(spec.targetIndex, matchingSiblings.length));
    if (matchingSiblings.length === 0) {
      const grouped = flattenNovelOrder(volumes, acts, updatedChapters, withoutMoved);
      insertPos = grouped.indexOf(spec.chapterId);
    } else if (clamped < matchingSiblings.length) {
      insertPos = withoutMoved.indexOf(matchingSiblings[clamped]);
    } else {
      const lastSibling = matchingSiblings[matchingSiblings.length - 1];
      insertPos = withoutMoved.indexOf(lastSibling) + 1;
    }
  } else {
    const grouped = flattenNovelOrder(volumes, acts, updatedChapters, withoutMoved);
    return { beforeOrder, afterOrder: grouped };
  }

  const reordered = [...withoutMoved];
  reordered.splice(Math.max(0, insertPos), 0, spec.chapterId);
  const afterOrder = flattenNovelOrder(volumes, acts, updatedChapters, reordered);
  return { beforeOrder, afterOrder };
}
