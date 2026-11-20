import { QA_REFINEMENT_LIMIT, qaPassed, type ArticleQa } from "./rules.ts";

export interface RefineArticleOptions {
  readonly signal?: AbortSignal;
  readonly keepBest?: boolean;
}

function qaRankKey(qa: ArticleQa): readonly [number, number, number, number] {
  return [
    qaPassed(qa) ? 1 : 0,
    Number.isFinite(qa.overall) ? qa.overall : -1,
    -qa.hardGates.length,
    -qa.fails.length,
  ];
}

function isAtLeastAsGoodQa(next: ArticleQa, best: ArticleQa): boolean {
  const a = qaRankKey(next);
  const b = qaRankKey(best);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export async function refineArticle(
  initial: string,
  assess: (body: string) => Promise<ArticleQa>,
  revise: (body: string, qa: ArticleQa) => Promise<string>,
  options?: RefineArticleOptions,
) {
  const signal = options?.signal;
  const keepBest = options?.keepBest !== false;

  signal?.throwIfAborted();
  let body = initial;
  let qa = await assess(body);
  let bestBody = body;
  let bestQa = qa;
  let rounds = 0;

  while (!qaPassed(qa) && rounds < QA_REFINEMENT_LIMIT) {
    signal?.throwIfAborted();
    body = await revise(body, qa);
    rounds += 1;
    signal?.throwIfAborted();
    qa = await assess(body);
    if (isAtLeastAsGoodQa(qa, bestQa)) {
      bestBody = body;
      bestQa = qa;
    }
  }

  return keepBest ? { body: bestBody, qa: bestQa, rounds } : { body, qa, rounds };
}
