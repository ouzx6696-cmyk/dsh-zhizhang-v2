// Browser-served mirror of src/contracts/protected-rules.ts.
//
// The workbench modules are served under /api/zhizhang/, so a browser import
// cannot reach src/contracts/. This file restates the canonical values
// byte-for-byte; test/01-contracts-protected.test.mjs asserts it equals the canonical module.
// Never edit values here: change src/contracts/protected-rules.ts (with author
// authorization) and copy the export block over unchanged.

export const TITLE_MAX = 34 as const;
export const QA_PASS_SCORE = 84 as const;
export const QA_REFINEMENT_LIMIT = 2 as const;
export const EDITORIAL_REJECTION_LIMIT = 2 as const;
export const DELIVERY_ENDING = "——AI 到此止步。是否采用、何时发布由你决定。" as const;

export const CHAPTER_STATES = ["planned", "drafting", "drafted", "reviewed", "final"] as const;
export type ProtectedChapterState = (typeof CHAPTER_STATES)[number];

export const ARTICLE_STATES = ["初稿待改", "待验收", "已验收", "验收退回", "已交稿"] as const;
export type ProtectedArticleState = (typeof ARTICLE_STATES)[number];
