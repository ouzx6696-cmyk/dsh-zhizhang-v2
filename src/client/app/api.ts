import type {
  ApiEnvelope,
  WorkspaceAction,
  WorkspaceStateResponse,
} from "../../contracts/workspace.ts";

export class WorkbenchApiError extends Error {
  readonly code: string;
  readonly diagnosticId?: string;

  constructor(message: string, code: string, diagnosticId?: string) {
    super(message);
    this.name = "WorkbenchApiError";
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  "generation-in-progress": "该稿件已有活动任务，请先完成或取消当前任务。",
  "generation-needs-reconciliation": "上一次任务仍在结束或等待用量核对，请刷新任务查看状态。",
  "export.conflict": "目标文件与获批稿件不同，请处理同名文件后重试。",
  "revision-locked": "当前稿件已定稿或验收锁定，无法继续覆盖正文。",
  "setting-is-locked": "该设定编号已锁定，无法用新提案覆盖。",
  "editorial-rejection-limit": "审稿打回已达 2 次上限。",
  "qa-refinement-unavailable": "当前状态不可回改，或已达到 2 轮回改上限。",
  "qa-pass-required": "需先通过质检（≥ 84 分、零未通过项、零硬门）方可验收。",
  "approval-missing": "交稿前请先明确批准当前修订版本。",
  "title-limit": "标题最多 34 个 Unicode 字符。",
  "micro-has-no-title": "微头条不设标题。",
};

function formatApiFailure(packet: {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly diagnosticId?: string;
}): WorkbenchApiError {
  const details = packet.details ?? {};
  const reason = typeof details.reason === "string"
    ? details.reason
    : typeof details.field === "string"
      ? details.field
      : undefined;

  const baseMessage =
    (reason ? REASON_MESSAGES[reason] : undefined) ??
    (packet.code === "version.conflict"
      ? "稿件版本已更新。本地编辑已保留，请对照服务器版本后再保存。"
      : [packet.code, reason].filter(Boolean).join(" · "));

  const message = packet.diagnosticId ? `${baseMessage}（诊断号 ${packet.diagnosticId}）` : baseMessage;
  return new WorkbenchApiError(message, packet.code, packet.diagnosticId);
}

export async function fetchWorkspaceState(
  projectId: string,
  documentId: string,
  ifSequence?: number,
): Promise<WorkspaceStateResponse> {
  const url = new URL("./state", location.href);
  if (projectId) url.searchParams.set("projectId", projectId);
  if (documentId) url.searchParams.set("documentId", documentId);
  if (ifSequence !== undefined) url.searchParams.set("ifSequence", String(ifSequence));

  const response = await fetch(url);
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new WorkbenchApiError("请从 DsH 已登录页面打开织章。", "auth.denied");
  }
  const packet = (await response.json()) as ApiEnvelope<WorkspaceStateResponse>;
  if (!packet || typeof packet.ok !== "boolean") {
    throw new WorkbenchApiError("工作台返回了无法识别的结果。", "internal.error");
  }
  if (!packet.ok) throw formatApiFailure(packet);
  return packet.result;
}

export async function mutateWorkspace<T = unknown>(
  action: WorkspaceAction,
  input: Record<string, unknown>,
  projectId: string,
  documentId: string,
): Promise<T> {
  const url = new URL("./mutate", location.href);
  if (projectId) url.searchParams.set("projectId", projectId);
  if (documentId) url.searchParams.set("documentId", documentId);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }),
  });
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new WorkbenchApiError("请从 DsH 已登录页面打开织章。", "auth.denied");
  }
  const packet = (await response.json()) as ApiEnvelope<T>;
  if (!packet || typeof packet.ok !== "boolean") {
    throw new WorkbenchApiError("工作台返回了无法识别的结果。", "internal.error");
  }
  if (!packet.ok) throw formatApiFailure(packet);
  return packet.result;
}
