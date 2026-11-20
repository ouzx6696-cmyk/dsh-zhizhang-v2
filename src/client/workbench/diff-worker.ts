import {
  computeInlineDiff,
  computeParagraphDiff,
  type InlineDiffSegment,
  type ParagraphDiffSummary,
} from "./diff.ts";

export const LARGE_DIFF_PARAGRAPH_THRESHOLD = 2000;
export const LARGE_DIFF_CHAR_THRESHOLD = 200_000;

export type DiffWorkerRequest =
  | { readonly id: number; readonly op: "paragraph"; readonly original: string; readonly candidate: string }
  | { readonly id: number; readonly op: "inline"; readonly before: string; readonly after: string };

export type DiffWorkerResponse =
  | { readonly id: number; readonly op: "paragraph"; readonly ok: true; readonly result: ParagraphDiffSummary }
  | { readonly id: number; readonly op: "inline"; readonly ok: true; readonly result: InlineDiffSegment[] }
  | { readonly id: number; readonly op: DiffWorkerRequest["op"]; readonly ok: false; readonly error: string };

export interface DiffWorkerLike {
  postMessage(message: DiffWorkerRequest): void;
  addEventListener(type: "message", listener: (event: { readonly data: DiffWorkerResponse }) => void): void;
  addEventListener(type: "error", listener: (event: { readonly message?: string }) => void): void;
  terminate(): void;
}

export interface DiffWorkerClientOptions {
  readonly workerUrl?: string | URL;
  readonly createWorker?: (url: string | URL) => DiffWorkerLike;
}

/**
 * Checks whether a manuscript diff is large enough to benefit from off-main-thread
 * Worker execution (FE-14 / Res#20: > 2,000 paragraphs or > 200,000 characters).
 */
export function isLargeDiff(original: string, candidate: string): boolean {
  if (original.length + candidate.length > LARGE_DIFF_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === 10) {
      lines++;
      if (lines > LARGE_DIFF_PARAGRAPH_THRESHOLD) return true;
    }
  }
  lines = 1;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate.charCodeAt(i) === 10) {
      lines++;
      if (lines > LARGE_DIFF_PARAGRAPH_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Pure request dispatcher shared by the Web Worker runtime and unit tests.
 */
export function handleDiffWorkerMessage(request: DiffWorkerRequest): DiffWorkerResponse {
  try {
    if (request.op === "paragraph") {
      return {
        id: request.id,
        op: "paragraph",
        ok: true,
        result: computeParagraphDiff(request.original, request.candidate),
      };
    }
    return {
      id: request.id,
      op: "inline",
      ok: true,
      result: computeInlineDiff(request.before, request.after),
    };
  } catch (error) {
    return {
      id: request.id,
      op: request.op,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface WorkerGlobalLike {
  postMessage(message: DiffWorkerResponse): void;
  addEventListener(type: "message", listener: (event: { readonly data: DiffWorkerRequest }) => void): void;
}

const isDedicatedWorkerScope =
  typeof self !== "undefined" &&
  typeof window === "undefined" &&
  typeof document === "undefined" &&
  typeof (self as unknown as Partial<WorkerGlobalLike>).postMessage === "function" &&
  typeof (self as unknown as Partial<WorkerGlobalLike>).addEventListener === "function";

if (isDedicatedWorkerScope) {
  const workerSelf = self as unknown as WorkerGlobalLike;
  workerSelf.addEventListener("message", (event) => {
    workerSelf.postMessage(handleDiffWorkerMessage(event.data));
  });
}

/**
 * Creates a reusable diff client that dispatches large diffs to a module Web Worker
 * when available and transparently falls back to main-thread execution on smaller
 * inputs, unsupported environments, or worker load failures.
 */
export function createDiffWorkerClient(options?: DiffWorkerClientOptions) {
  let worker: DiffWorkerLike | null = null;
  let workerDisabled = false;
  let nextId = 1;

  interface PendingJob {
    readonly resolve: (value: unknown) => void;
    readonly fallback: () => unknown;
  }
  const pending = new Map<number, PendingJob>();

  function failAllPendingToFallback(): void {
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) {
      job.resolve(job.fallback());
    }
  }

  function ensureWorker(): DiffWorkerLike | null {
    if (workerDisabled) return null;
    if (worker) return worker;
    try {
      const url = options?.workerUrl ?? new URL("./diff-worker.js", import.meta.url);
      const instance = options?.createWorker
        ? options.createWorker(url)
        : typeof Worker === "function"
          ? (new Worker(url, { type: "module" }) as unknown as DiffWorkerLike)
          : null;
      if (!instance) {
        workerDisabled = true;
        return null;
      }
      instance.addEventListener("message", (event) => {
        const res = event.data;
        const job = pending.get(res.id);
        if (!job) return;
        pending.delete(res.id);
        if (res.ok) {
          job.resolve(res.result);
        } else {
          job.resolve(job.fallback());
        }
      });
      instance.addEventListener("error", () => {
        workerDisabled = true;
        try {
          instance.terminate();
        } catch {
          // Ignore teardown errors.
        }
        worker = null;
        failAllPendingToFallback();
      });
      worker = instance;
      return worker;
    } catch {
      workerDisabled = true;
      return null;
    }
  }

  function dispatch<T>(request: DiffWorkerRequest, fallback: () => T, useWorker: boolean): Promise<T> {
    if (!useWorker) {
      return Promise.resolve(fallback());
    }
    const activeWorker = ensureWorker();
    if (!activeWorker) {
      return Promise.resolve(fallback());
    }
    return new Promise<T>((resolve) => {
      pending.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        fallback,
      });
      try {
        activeWorker.postMessage(request);
      } catch {
        pending.delete(request.id);
        workerDisabled = true;
        resolve(fallback());
      }
    });
  }

  return {
    computeParagraphDiffAsync(
      original: string,
      candidate: string,
      opts?: { readonly forceWorker?: boolean },
    ): Promise<ParagraphDiffSummary> {
      const id = nextId++;
      const useWorker = Boolean(opts?.forceWorker) || isLargeDiff(original, candidate);
      return dispatch(
        { id, op: "paragraph", original, candidate },
        () => computeParagraphDiff(original, candidate),
        useWorker,
      );
    },

    computeInlineDiffAsync(
      before: string,
      after: string,
      opts?: { readonly forceWorker?: boolean },
    ): Promise<InlineDiffSegment[]> {
      const id = nextId++;
      const useWorker = Boolean(opts?.forceWorker) || before.length + after.length > LARGE_DIFF_CHAR_THRESHOLD;
      return dispatch(
        { id, op: "inline", before, after },
        () => computeInlineDiff(before, after),
        useWorker,
      );
    },

    terminate(): void {
      if (worker) {
        try {
          worker.terminate();
        } catch {
          // Ignore teardown errors.
        }
        worker = null;
      }
      failAllPendingToFallback();
    },
  };
}

export type DiffWorkerClient = ReturnType<typeof createDiffWorkerClient>;
