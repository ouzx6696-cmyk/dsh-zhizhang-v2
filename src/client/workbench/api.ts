import type { UnifiedJobSummaryDto, WorkspaceStateResponse } from "../../contracts/workspace-dto.ts";
import { TITLE_MAX } from "../contracts/protected-rules.ts";

interface ApiPacket<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly diagnosticId?: string;
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  "generation-in-progress": "该稿件已有活动任务，请先完成或取消当前任务。",
  "generation-needs-reconciliation": "上一次任务仍在结束或等待用量核对。请刷新任务查看状态。",
  "proposal-in-progress": "同类型 AI 提案任务正在生成中，请稍候。",
  "rewrite-in-progress": "当前章节已有选段微改写在进行中，请稍候。",
  "no-final-chapters": "当前作品还没有定稿章节。",
  "import-upload-missing": "导入暂存已过期，请重新选择文件。",
  "proposal-stale": "提案生成后章节已被修改，请拒绝本提案并重新生成。",
  "preview-no-llm-transport": "本地预览模式未连接 DsH 模型通道，可通过“手动导入候选稿”演练差异对照与采纳流。",
  "export.conflict": "目标文件与获批稿件不同，请处理同名文件后重试。",
  "revision-locked": "该稿件已锁定，无法继续修改正文。",
  "setting-is-locked": "该编号的设定已锁定，拒绝覆盖。",
  "editorial-rejection-limit": "已达两次审稿打回上限。",
  "qa-refinement-limit": "已达两轮自动回改上限。",
  "qa-refinement-unavailable": "当前状态不可保存回改稿或已达回改上限。",
  "approval-missing": "请先批准当前版本后再交稿。",
  "title-limit": `标题最多 ${TITLE_MAX} 个 Unicode 字符。`,
  "micro-has-no-title": "微头条不设标题。",
  "quote-must-match-exactly-once": "摘句必须在已保存正文中唯一匹配一次。",
  "autopilot-in-progress": "该自动化批次已在运行中，请先暂停或等待当前步骤完成。",
  "material-extract-in-progress": "该材料会话正在 AI 标准化提炼中，请稍候。",
  "cannot-autopilot-final-chapter": "已定稿章节处于锁定状态，不可纳入全自动改写队列。",
  "session-already-committed": "该非标准材料会话已完成原子入库，不可重复提交。",
  "session-not-ready": "请先完成切片确认或生成标准化提案包后再执行入库。",
  "batch-not-running": "当前批次未处于运行状态。",
  "no-snapshot-to-rollback": "本章没有可回滚的批次前快照。",
  "rollback-requires-direct-write": "仅共创模式直写草稿支持版本回滚，审慎模式候选稿请直接在 Diff 区舍弃。",
  "already-rolled-back": "该条 Agent 写入记录已完成回滚，无需重复操作。",
  "project-mismatch": "目标章节与当前作品不匹配，请刷新后重试。",
  "non-empty-array-required": "局部精修必须至少提供一条段落补丁。",
  "resulting-body-empty": "应用补丁后的正文为空，已拒绝写入。",
};

export interface WorkbenchRequestContext {
  readonly projectId: string;
  readonly documentId: string;
}

export interface ApiRequestOptions {
  /** Test/feature override; defaults to the per-action budget below. */
  readonly timeoutMs?: number;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const IO_TIMEOUT_MS = 120_000;

const IO_ACTIONS: ReadonlySet<string> = new Set([
  "project.export_bundle",
  "project.import_bundle",
  "selection.rewrite",
  "article.deliver",
  "skill.import",
  "material.preprocess",
  "material.commit",
]);

/** State reads 15s, ordinary writes 30s, long-running I/O & sync rewrite 120s. */
export function actionTimeoutMs(action?: string): number {
  if (!action) return READ_TIMEOUT_MS;
  return IO_ACTIONS.has(action) ? IO_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

function timeoutMessage(timeoutMs: number): string {
  return `请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应。本地草稿已保留，请刷新确认服务器状态后再重试。`;
}

function resolveEndpoint(
  action?: string,
  input?: Record<string, unknown>,
): { readonly path: string; readonly method: "GET" | "POST"; readonly body?: Record<string, unknown> } {
  if (!action) {
    return { path: "./state", method: "GET" };
  }
  if (action === "jobs.cancel") {
    return { path: "./jobs/cancel", method: "POST", body: { ...(input ?? {}) } };
  }
  if (action === "jobs.list") {
    return { path: "./jobs", method: "GET" };
  }
  if (action === "run.preview") {
    return { path: "./jobs/preview", method: "POST", body: { ...(input ?? {}) } };
  }
  if (action === "run.generate") {
    return { path: "./jobs/start", method: "POST", body: { ...(input ?? {}), kind: "draft_generation" } };
  }
  if (action === "proposal.generate") {
    const proposalKind = typeof input?.kind === "string" ? input.kind : input?.proposalKind;
    return {
      path: "./jobs/start",
      method: "POST",
      body: { ...(input ?? {}), kind: "proposal_extraction", proposalKind },
    };
  }
  if (action === "selection.rewrite") {
    return { path: "./jobs/start", method: "POST", body: { ...(input ?? {}), kind: "selection_rewrite" } };
  }
  if (action === "run.cancel") {
    return { path: "./jobs/cancel", method: "POST", body: { ...(input ?? {}), kind: "draft_generation" } };
  }
  if (action === "proposal.cancel") {
    return { path: "./jobs/cancel", method: "POST", body: { ...(input ?? {}), kind: "proposal_extraction" } };
  }
  if (action === "autopilot.start" || action === "autopilot.resume") {
    return { path: "./jobs/start", method: "POST", body: { ...(input ?? {}), kind: "autopilot_pipeline" } };
  }
  if (action === "material.extract") {
    return { path: "./jobs/start", method: "POST", body: { ...(input ?? {}), kind: "material_normalize" } };
  }
  if (action === "autopilot.cancel") {
    return { path: "./jobs/cancel", method: "POST", body: { ...(input ?? {}), kind: "autopilot_pipeline" } };
  }
  return { path: "./command", method: "POST", body: { action, ...(input ?? {}) } };
}

export async function apiRequest<T>(
  context: WorkbenchRequestContext,
  action?: string,
  input?: Record<string, unknown>,
  ifSequence?: number,
  options: ApiRequestOptions = {},
): Promise<T> {
  const endpoint = resolveEndpoint(action, input);
  const url = new URL(endpoint.path, location.href);
  if (endpoint.method === "GET") {
    if (context.projectId) url.searchParams.set("projectId", context.projectId);
    if (context.documentId) url.searchParams.set("documentId", context.documentId);
    if (ifSequence !== undefined) url.searchParams.set("ifSequence", String(ifSequence));
    if (action === "jobs.list" && input) {
      if (typeof input.kind === "string" && input.kind) url.searchParams.set("kind", input.kind);
      if (typeof input.limit === "number") url.searchParams.set("limit", String(input.limit));
    }
  }

  const timeoutMs = options.timeoutMs ?? actionTimeoutMs(action);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchOptions: RequestInit = {
    ...(endpoint.method === "POST"
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(endpoint.body ?? {}),
        }
      : {}),
    signal: timeoutSignal,
  };

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    if (timeoutSignal.aborted) throw new Error(timeoutMessage(timeoutMs));
    throw error;
  }
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("请从 DsH 已登录页面打开织章。");
  }
  const packet = (await response.json()) as ApiPacket<T>;
  if (!packet || typeof packet.ok !== "boolean") {
    throw new Error("工作台返回了无法识别的结果。");
  }
  if (!packet.ok) {
    const details = packet.details ?? {};
    const reason = typeof details.reason === "string"
      ? details.reason
      : typeof details.field === "string"
        ? details.field
        : undefined;
    const message = (reason && REASON_MESSAGES[reason])
      ?? (packet.code === "version.conflict"
        ? "稿件版本已更新。本地编辑已保留，请刷新后核对再保存。"
        : [packet.code, reason].filter(Boolean).join(" · "));
    throw new Error(packet.diagnosticId ? `${message}（诊断号 ${packet.diagnosticId}）` : message);
  }
  return packet.result as T;
}

export async function fetchWorkspaceState(
  context: WorkbenchRequestContext,
  ifSequence?: number,
): Promise<WorkspaceStateResponse> {
  return apiRequest<WorkspaceStateResponse>(context, undefined, undefined, ifSequence);
}

export async function fetchWorkspaceJobs(
  context: WorkbenchRequestContext,
  limit = 20,
): Promise<readonly UnifiedJobSummaryDto[]> {
  return apiRequest<readonly UnifiedJobSummaryDto[]>(context, "jobs.list", { limit });
}
