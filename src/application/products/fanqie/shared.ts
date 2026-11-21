import type { SettingFact } from "../../../domain/fanqie/index.ts";
import { currentSeq, stmt, type SqliteDatabase } from "../../../storage/index.ts";
import { invalid, requiredRow, text, type Input, type Product, type WorkspaceContext } from "../../context.ts";

const factCache = new WeakMap<SqliteDatabase, Map<string, { readonly seq: number; readonly facts: SettingFact[] }>>();

export function assertFanqieProject(ctx: WorkspaceContext, projectId: string): void {
  const project = requiredRow<{ product: Product }>(
    stmt(ctx.db, "SELECT product FROM author_projects WHERE id = ?;").get(projectId),
    "project",
    projectId,
  );
  if (project.product !== "fanqie") invalid("projectId", "novel-required");
}

/**
 * Resolves the existing library row for `id` and refuses a cross-project or
 * cross-scope overwrite (FQ-06), returning the original `created_at` so an
 * update keeps its creation timestamp.
 */
export function assertLibraryWriteScope(
  ctx: WorkspaceContext,
  table: "library_deconstructions" | "library_technique_cards",
  id: string,
  scope: string,
  projectId: string | null,
): number | undefined {
  const row = stmt(
    ctx.db,
    `SELECT created_at AS createdAt, scope, project_id AS projectId FROM ${table} WHERE id = ?;`,
  ).get(id) as { createdAt?: number; scope?: string; projectId?: string | null } | undefined;
  if (row && (row.scope !== scope || row.projectId !== (projectId ?? null))) {
    invalid("id", "scope-mismatch");
  }
  return row?.createdAt;
}

/**
 * Returns approved setting facts ordered by `(decided_seq ASC, sequence ASC)`
 * with a per-connection `(projectId, currentSeq)` memo cache that stays coherent
 * across multiple WAL connections.
 */
export function approvedFacts(ctx: WorkspaceContext, projectId: string): SettingFact[] {
  const seq = currentSeq(ctx.db, projectId);
  let byProject = factCache.get(ctx.db);
  if (!byProject) {
    byProject = new Map();
    factCache.set(ctx.db, byProject);
  }
  const cached = byProject.get(projectId);
  if (cached && cached.seq === seq) {
    return cached.facts;
  }
  const rows = stmt(ctx.db, `
    SELECT value FROM author_settings
    WHERE project_id = ? AND decision = 'approved'
    ORDER BY decided_seq ASC, sequence ASC;
  `).all(projectId) as readonly { value: string }[];
  const facts = rows.map(({ value }) => JSON.parse(value) as SettingFact);
  byProject.set(projectId, { seq, facts });
  return facts;
}

export function reorderRelations(facts: readonly SettingFact[]) {
  return facts.map((fact) => ({
    id: fact.id,
    relations: [
      ...(fact.effectiveTo ? [{ from: fact.effectiveFrom, to: fact.effectiveTo, label: "设定有效期" }] : []),
      ...Object.entries(fact.knownFrom).map(([character, at]) => ({
        from: fact.effectiveFrom,
        to: at,
        label: `${character}知晓`,
      })),
    ],
  }));
}

export function assertChapterInProject(ctx: WorkspaceContext, projectId: string, chapterId: string, field: string): void {
  const row = stmt(ctx.db, "SELECT project_id AS projectId FROM author_documents WHERE id = ?;")
    .get(chapterId) as { projectId?: string } | undefined;
  if (!row || row.projectId !== projectId) {
    invalid(field, "chapter-not-in-project");
  }
}

export function optionalNullableId(input: Input, field: string): string | null | undefined {
  if (input[field] === undefined) return undefined;
  if (input[field] === null || input[field] === "") return null;
  return text(input, field).trim();
}
