import type { WorkspaceStateResponse } from "../../contracts/workspace-dto.ts";
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
  "proposal-stale": "提案生成后章节已被修改，请拒绝本提案并重新生成。",
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
// FE-07: these actions wait synchronously on an LLM call, a full-database
// copy, or a bundle write, so a 30s budget would abort work the server is
// still completing (and leave a half-finished save behind).
const IO_ACTIONS: ReadonlySet<string> = new Set([
  "project.export_bundle",
  "project.import_bundle",
  "selection.rewrite",
  "backup.create",
  "article.deliver",
  "skill.import",
  "project.bootstrap",
  "revisions.compact",
]);

/** FE-07: state reads 15s, ordinary writes 30s, long-running actions 120s. */
export function actionTimeoutMs(action?: string): number {
  if (!action) return READ_TIMEOUT_MS;
  return IO_ACTIONS.has(action) ? IO_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

function timeoutMessage(timeoutMs: number): string {
  return `请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应。本地草稿已保留，请刷新确认服务器状态后再重试。`;
}

export async function apiRequest<T>(
  context: WorkbenchRequestContext,
  action?: string,
  input?: Record<string, unknown>,
  ifSequence?: number,
  options: ApiRequestOptions = {},
): Promise<T> {
  const url = new URL(action ? "./mutate" : "./state", location.href);
  if (context.projectId) url.searchParams.set("projectId", context.projectId);
  if (context.documentId) url.searchParams.set("documentId", context.documentId);
  if (ifSequence !== undefined) url.searchParams.set("ifSequence", String(ifSequence));

  const timeoutMs = options.timeoutMs ?? actionTimeoutMs(action);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchOptions: RequestInit = {
    ...(action
      ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...input }),
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
