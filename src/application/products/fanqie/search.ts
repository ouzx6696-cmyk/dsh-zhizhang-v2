import type { SearchHitDto } from "../../../contracts/workspace-dto.ts";
import { searchWorkspaceFts, type FtsSearchScope } from "../../../storage/index.ts";
import { count, invalid, text, type Input, type WorkspaceContext } from "../../context.ts";
import { assertFanqieProject } from "./shared.ts";

const VALID_SCOPES: ReadonlySet<string> = new Set(["chapter", "lore", "deconstruction", "technique"]);

export function searchFanqieWorkspace(ctx: WorkspaceContext, input: Input): SearchHitDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const query = text(input, "query");
  let scopes: FtsSearchScope[] | undefined;
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.some((s) => typeof s !== "string" || !VALID_SCOPES.has(s))) {
      invalid("scopes", "invalid-search-scopes");
    }
    scopes = input.scopes as FtsSearchScope[];
  }
  const limit = input.limit !== undefined ? count(input, "limit") : 30;
  return ctx.read(() => searchWorkspaceFts(ctx.db, { projectId, query, scopes, limit }));
}
