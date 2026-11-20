// Single source of truth for author-protected business constants (V2.3 Res#2).
//
// Strictly browser-safe, zero-import pure `as const` definitions. None of
// these values may be changed, widened, narrowed, or re-derived without
// explicit author authorization (see AGENTS.md "Protected business rules").

export const TITLE_MAX = 34 as const;
export const QA_PASS_SCORE = 84 as const;
export const QA_REFINEMENT_LIMIT = 2 as const;
export const EDITORIAL_REJECTION_LIMIT = 2 as const;
export const DELIVERY_ENDING = "——AI 到此止步。是否采用、何时发布由你决定。" as const;

export const CHAPTER_STATES = ["planned", "drafting", "drafted", "reviewed", "final"] as const;
export type ProtectedChapterState = (typeof CHAPTER_STATES)[number];

export const ARTICLE_STATES = ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"] as const;
export type ProtectedArticleState = (typeof ARTICLE_STATES)[number];
