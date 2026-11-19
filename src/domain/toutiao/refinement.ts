import { QA_REFINEMENT_LIMIT, qaPassed, type ArticleQa } from "./index.ts";

export async function refineArticle(
  initial: string,
  assess: (body: string) => Promise<ArticleQa>,
  revise: (body: string, qa: ArticleQa) => Promise<string>,
) {
  let body = initial;
  let qa = await assess(body);
  let rounds = 0;
  while (!qaPassed(qa) && rounds < QA_REFINEMENT_LIMIT) {
    body = await revise(body, qa);
    rounds += 1;
    qa = await assess(body);
  }
  return { body, qa, rounds };
}
