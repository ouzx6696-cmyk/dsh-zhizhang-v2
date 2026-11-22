import { createHash } from "node:crypto";
import type { WritingPhase } from "./writing-stages.ts";
import {
  ARC_PLAN_SYSTEM,
  BEAT_PLAN_SYSTEM,
  CHAPTER_REVIEW_SYSTEM,
  DECONSTRUCT_EXTRACT_SYSTEM,
  FACT_SYNC_SYSTEM,
  MATERIAL_NORMALIZE_SYSTEM,
  QA_SYSTEM,
  SELECTION_REWRITE_SYSTEM,
  SETTING_EXTRACT_SYSTEM,
  SUMMARY_DRAFT_SYSTEM,
  SURGICAL_PATCH_SYSTEM,
  TECHNIQUE_EXTRACT_SYSTEM,
  WRITER_SYSTEM,
} from "./prompts/index.ts";

/**
 * L0 Unified Shared System Kernel (`zhizhang/3.0` 4-Tier Prompt Cache Architecture).
 *
 * Shared verbatim at Token 0 across ALL long-form novel job kinds (draft writing,
 * selection micro-rewrite, qualitative chapter review, fact/memory sync, summary
 * drafting, setting extraction, and rolling arc planning). Task-specific roles
 * and output formats are placed at the L3 tail so L0 + L1 + L2 achieve strict
 * byte-for-byte prefix KV cache reuse across the entire writing session.
 */
export const SHARED_WORKBENCH_SYSTEM_KERNEL = [
  "你是织章（Zhizhang）长篇创作与编审引擎。",
  "你必须严格遵循上下文中的【L1 全书冻结设定圣经】与【L2 卷幕里程碑】，并始终尊重作者主权：",
  "1. 严禁虚构或篡改已锁定设定；严禁让当前视角人物获知其视角边界之外的信息。",
  "2. 严禁执行任何外部工具或写库操作；一切产出均作为隔离候选稿或待作者审阅的提案。",
  "3. 严格依据文末【L3 本次执行任务协议】指定的角色、范围与输出格式返回结果，不附带多余解释。",
].join("\n");

export type CacheProviderStrategy =
  | "deepseek-implicit"
  | "anthropic-breakpoints"
  | "openai-implicit"
  | "compact-local";

export interface LayeredPromptPayload {
  /** L0: shared system kernel (byte-identical across all book jobs). */
  readonly systemKernel: string;
  /** L1: version-pinned book bible snapshot (fixed budget, decoupled from tokenLimit/stage). */
  readonly bookPrefix?: string;
  readonly bookPrefixSha256?: string;
  readonly bookSnapshotVersion?: number;
  /** L2: append-only volume/act & 10-chapter milestone ledger. */
  readonly volumePrefix?: string;
  readonly volumePrefixSha256?: string;
  /** L3: per-request dynamic tail (delta patches, POV boundary, active draft, task protocol). */
  readonly dynamicTail: string;
  /** Stable per-book cache routing key (e.g. `zhizhang:<projectId>`). */
  readonly cachePartitionKey?: string;
}

export interface CacheStreamPayload {
  readonly system: string | readonly Record<string, unknown>[];
  readonly messages: readonly Record<string, unknown>[];
  readonly extraOptions: Readonly<Record<string, unknown>>;
  readonly strategy: CacheProviderStrategy;
  readonly prefixSha256: string | null;
  readonly l1Version: number | null;
  readonly estimatedTextForReserve: { readonly systemText: string; readonly promptText: string };
}

/**
 * Normalizes line endings and trims trailing whitespace per line so KV-cache
 * prefixes never miss due to accidental CRLF / trailing-space drift.
 */
export function normalizeCacheText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function sha256Prefix(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Recursively sorts all plain-object keys in lexicographical order so JSON
 * schemas (e.g., DsH Agent tool definitions) and serialized payloads are 100%
 * byte-deterministic across reloads.
 */
export function canonicalizeJsonKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonKeys(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeJsonKeys(record[key]);
    }
    return sorted as T;
  }
  return value;
}

/**
 * Resolves the optimal DsH prompt-caching wire strategy for a `(provider, model)` pair.
 */
export function resolveCacheProviderStrategy(provider: string, model: string): CacheProviderStrategy {
  const combined = `${provider} ${model}`.toLowerCase();
  if (combined.includes("claude") || combined.includes("anthropic")) {
    return "anthropic-breakpoints";
  }
  if (
    combined.includes("ollama")
    || combined.includes("lmstudio")
    || combined.includes("local")
    || combined.includes("vllm-small")
  ) {
    return "compact-local";
  }
  if (
    combined.includes("openai")
    || /\bgpt-/u.test(combined)
    || /\bo[134](?:-|\b)/u.test(combined)
  ) {
    return "openai-implicit";
  }
  return "deepseek-implicit";
}

const PHASE_TASK_PROTOCOLS: Readonly<Record<WritingPhase, string>> = {
  write: WRITER_SYSTEM,
  qa: QA_SYSTEM,
  refine: WRITER_SYSTEM,
  deconstructExtract: DECONSTRUCT_EXTRACT_SYSTEM,
  techniqueExtract: TECHNIQUE_EXTRACT_SYSTEM,
  settingExtract: SETTING_EXTRACT_SYSTEM,
  summaryDraft: SUMMARY_DRAFT_SYSTEM,
  factSync: FACT_SYNC_SYSTEM,
  chapterReview: CHAPTER_REVIEW_SYSTEM,
  arcPlan: ARC_PLAN_SYSTEM,
  selectionRewrite: SELECTION_REWRITE_SYSTEM,
  beatPlan: BEAT_PLAN_SYSTEM,
  surgicalPatch: SURGICAL_PATCH_SYSTEM,
  materialNormalize: MATERIAL_NORMALIZE_SYSTEM,
};

/**
 * Renders the L3 task-specific protocol footer so every job kind keeps its exact
 * role & output contract while sharing the identical L0 + L1 + L2 prefix.
 */
export function buildTaskProtocolSection(phase: WritingPhase, extraDirectives?: string): string {
  const base = PHASE_TASK_PROTOCOLS[phase] ?? WRITER_SYSTEM;
  const lines = ["### 【L3 本次执行任务协议】", base];
  if (extraDirectives && extraDirectives.trim()) {
    lines.push(extraDirectives.trim());
  }
  return lines.join("\n");
}

/**
 * Translates a single-shot request (layered or plain) into provider-aware DsH
 * `call.stream(...)` options without ever emitting non-standard `cachePrefix`.
 *
 * - `deepseek-implicit`: merges L0 + L1 + L2 into a single deterministic `system`
 *   prefix block (0-token-offset strict match) and puts L3 into the `user` message.
 * - `openai-implicit`: same 0-offset prefix layout plus `prompt_cache_key`
 *   scoped per book (`zhizhang:<projectId>`).
 * - `anthropic-breakpoints`: emits structured `system` content blocks with explicit
 *   `cache_control: { type: "ephemeral" }` breakpoints at the end of L1 and L2.
 * - `compact-local`: strips heavy L1/L2 prefix blocks for constrained local models
 *   to prevent context overflow while preserving L0 + L3.
 */
export function buildLayeredStreamPayload(
  request: {
    readonly system: string;
    readonly prompt: string;
    readonly layered?: LayeredPromptPayload;
  },
  provider: string,
  model: string,
): CacheStreamPayload {
  const strategy = resolveCacheProviderStrategy(provider, model);

  if (!request.layered) {
    const cleanSystem = normalizeCacheText(request.system);
    const cleanPrompt = normalizeCacheText(request.prompt);
    return {
      system: cleanSystem,
      messages: [{ role: "user", content: [{ type: "text", text: cleanPrompt }] }],
      extraOptions: {},
      strategy,
      prefixSha256: cleanSystem ? sha256Prefix(cleanSystem) : null,
      l1Version: null,
      estimatedTextForReserve: { systemText: cleanSystem, promptText: cleanPrompt },
    };
  }

  const l0 = normalizeCacheText(request.layered.systemKernel || SHARED_WORKBENCH_SYSTEM_KERNEL);
  const l1 = normalizeCacheText(request.layered.bookPrefix ?? "");
  const l2 = normalizeCacheText(request.layered.volumePrefix ?? "");
  const l3 = normalizeCacheText(request.layered.dynamicTail || request.prompt);
  const l1Version = request.layered.bookSnapshotVersion ?? null;

  if (strategy === "compact-local") {
    return {
      system: l0,
      messages: [{ role: "user", content: [{ type: "text", text: l3 }] }],
      extraOptions: {},
      strategy,
      prefixSha256: sha256Prefix(l0),
      l1Version,
      estimatedTextForReserve: { systemText: l0, promptText: l3 },
    };
  }

  const prefixCombined = [l0, l1, l2].filter(Boolean).join("\n\n===\n\n");
  const prefixSha256 = sha256Prefix(prefixCombined);

  if (strategy === "anthropic-breakpoints") {
    const systemBlocks: Record<string, unknown>[] = [{ type: "text", text: l0 }];
    if (l1) {
      systemBlocks.push({
        type: "text",
        text: l1,
        cache_control: { type: "ephemeral" },
      });
    }
    if (l2) {
      systemBlocks.push({
        type: "text",
        text: l2,
        cache_control: { type: "ephemeral" },
      });
    }
    if (!l1 && !l2) {
      systemBlocks[0] = { type: "text", text: l0, cache_control: { type: "ephemeral" } };
    }
    return {
      system: systemBlocks,
      messages: [{ role: "user", content: [{ type: "text", text: l3 }] }],
      extraOptions: {},
      strategy,
      prefixSha256,
      l1Version,
      estimatedTextForReserve: { systemText: prefixCombined, promptText: l3 },
    };
  }

  const extraOptions: Record<string, unknown> = {};
  if (strategy === "openai-implicit" && request.layered.cachePartitionKey) {
    extraOptions.prompt_cache_key = request.layered.cachePartitionKey;
  }

  return {
    system: prefixCombined,
    messages: [{ role: "user", content: [{ type: "text", text: l3 }] }],
    extraOptions,
    strategy,
    prefixSha256,
    l1Version,
    estimatedTextForReserve: { systemText: prefixCombined, promptText: l3 },
  };
}

export interface CacheDiagnosisResult {
  readonly estimatedSavingsRatio: number | null;
  readonly prefixTransitions: number;
  readonly cacheDiagnosis: string | null;
}

/**
 * Analyzes per-call prefix hashes and 4-category usage receipts to explain why
 * cache hits succeeded or missed (stable hit, TTL/gateway miss, or L1/L2 shift).
 */
export function diagnoseCacheBehavior(
  calls: readonly {
    readonly prefixSha256?: string | null;
    readonly l1Version?: number | null;
    readonly usage?: readonly number[] | null;
  }[],
): CacheDiagnosisResult {
  let totalInput = 0;
  let totalCacheRead = 0;
  let prefixTransitions = 0;
  let lastHash: string | null = null;
  let l1Changed = false;
  let lastL1Version: number | null = null;
  let validCalls = 0;

  for (const call of calls) {
    if (call.prefixSha256) {
      if (lastHash !== null && lastHash !== call.prefixSha256) {
        prefixTransitions += 1;
        if (lastL1Version !== null && call.l1Version !== null && call.l1Version !== undefined && call.l1Version !== lastL1Version) {
          l1Changed = true;
        }
      }
      lastHash = call.prefixSha256;
      if (call.l1Version !== undefined && call.l1Version !== null) {
        lastL1Version = call.l1Version;
      }
    }
    const tuple = call.usage;
    if (!tuple || tuple.length < 2) continue;
    const input = Math.max(0, Number(tuple[0] ?? 0));
    const cacheRead = Math.max(0, Number(tuple[2] ?? 0));
    totalInput += input;
    totalCacheRead += cacheRead;
    validCalls += 1;
  }

  if (validCalls === 0) {
    return { estimatedSavingsRatio: null, prefixTransitions, cacheDiagnosis: null };
  }

  // DeepSeek charges ~0.1x on cache hits -> each cacheRead token saves ~0.9x input cost.
  const totalPrompt = totalCacheRead <= totalInput ? totalInput : totalInput + totalCacheRead;
  const hitRate = totalPrompt > 0 ? totalCacheRead / totalPrompt : 0;
  const estimatedSavingsRatio = totalPrompt > 0 ? Math.round(hitRate * 0.9 * 1000) / 1000 : 0;

  let cacheDiagnosis: string;
  if (totalCacheRead > 0 && prefixTransitions === 0) {
    cacheDiagnosis = `前缀稳定（命中 ${(hitRate * 100).toFixed(1)}%，估算节省输入费用 ${(estimatedSavingsRatio * 100).toFixed(1)}%）`;
  } else if (totalCacheRead > 0 && prefixTransitions > 0) {
    cacheDiagnosis = l1Changed
      ? `发生 ${prefixTransitions} 次前缀切换（L1 圣经快照升级）`
      : `发生 ${prefixTransitions} 次前缀切换（L2 里程碑更新）`;
  } else if (prefixTransitions > 0) {
    cacheDiagnosis = l1Changed
      ? "未命中缓存：L1 全书圣经版本变更导致前缀重建"
      : "未命中缓存：L2 卷幕里程碑变更导致前缀重建";
  } else if (validCalls >= 2) {
    cacheDiagnosis = "前缀哈希一致但缓存读为 0：可能已超服务端 TTL 窗口或网关未回传缓存用量";
  } else {
    cacheDiagnosis = "首次冷启动写入缓存，后续同书作业将复用 L0+L1+L2 前缀";
  }

  return { estimatedSavingsRatio, prefixTransitions, cacheDiagnosis };
}
