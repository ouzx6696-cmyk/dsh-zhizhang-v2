import { randomUUID } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function remapFactIds(items: unknown, oldToNew: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isRecord(item)) return item;
    const factId = typeof item.factId === "string" ? item.factId.trim() : "";
    const mapped = factId ? oldToNew.get(factId) : undefined;
    return mapped ? { ...item, factId: mapped } : item;
  });
}

/**
 * the prompt asks the model to omit `factId` for new facts, and the
 * server assigns a collision-free `fq-<uuid>` instead. Normalisation happens
 * before the proposal is stored, so the author sees real ids in the inbox and
 * the checklist can select rows that have no model-supplied id.
 *
 * Intra-payload references (a foreshadow or a knowledge update pointing at a
 * fact created by the same proposal) are rewritten through the same map, and
 * the model's original id is kept as `originalFactId` for audit only.
 *
 * Idempotent: a `fq-` id already issued by the server is left untouched, so
 * the decide path can safely re-normalise `editedPayload` for hand-written
 * proposals without changing ids the author already saw in the inbox.
 */
export function normalizeFactSyncPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const newFacts = Array.isArray(payload.newFacts) ? payload.newFacts.filter(isRecord) : [];
  if (newFacts.length === 0) return payload;

  const oldToNew = new Map<string, string>();
  const normalizedNewFacts = newFacts.map((item) => {
    const original = typeof item.factId === "string" ? item.factId.trim() : "";
    if (original.startsWith("fq-")) return item;
    const factId = `fq-${randomUUID()}`;
    if (original && !oldToNew.has(original)) oldToNew.set(original, factId);
    return {
      ...item,
      factId,
      ...(original ? { originalFactId: original } : {}),
    };
  });

  return {
    ...payload,
    newFacts: normalizedNewFacts,
    foreshadowUpdates: remapFactIds(payload.foreshadowUpdates, oldToNew),
    knownFromUpdates: remapFactIds(payload.knownFromUpdates, oldToNew),
  };
}
