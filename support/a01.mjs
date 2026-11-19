// Shared helpers for the A-01 acceptance fixtures.
//
// Every offline fixture records a mechanism with fixed inputs and pure
// functions. The pieces below are the ones more than one fixture needs, so
// they live here instead of being copied: the recorded-error base, the refusal
// assertion, the narrative anchor and its ordering, and the temp-directory
// wrapper. Fixtures keep their own local names by aliasing on import, so a
// fixture's wording stays about its own mechanism.
//
// Nothing in this module is part of the contract under test; it is test
// infrastructure only.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// The recorded error every fixture raises: a stable code plus the details a
// caller may see. Control flow branches on the code, never on the message.
export class RecordedError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "RecordedError";
    this.code = code;
    this.details = details;
  }
}

// Assert that a command result was refused with the expected code, and
// optionally that its disclosable details match.
export function assertRefused(result, code, details) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.code, code);
  if (details !== undefined) {
    assert.deepEqual(result.details, details);
  }
  return result;
}

// Assert that a call throws a recorded error with the expected code.
export function assertThrowsCode(fn, code) {
  return assert.throws(
    fn,
    (error) =>
      error instanceof RecordedError &&
      error.code === code &&
      typeof error.message === "string" &&
      error.message.length > 0,
  );
}

// A narrative anchor: a chapter plus an ordinal point inside it. It survives
// text edits, which is why character offsets belong to evidence location
// instead (contracts appendix B.8).
export function anchor(chapterId, point) {
  return { chapterId, point };
}

// Whether one anchor comes before another under a chapter order. Chapters
// missing from the order are treated as one group after the known ones, so a
// comparison between two unknown chapters falls back to the point.
export function precedes(a, b, chapterOrder) {
  const indexA = chapterOrder.indexOf(a.chapterId);
  const indexB = chapterOrder.indexOf(b.chapterId);
  if (indexA === indexB) return a.point < b.point;
  return indexA < indexB;
}

// Run a function with a fresh temporary directory that is always removed,
// including when the function throws.
//
// The removal is deliberately split from the failure path: on Windows an
// unclosed SQLite handle makes `rm` fail with EBUSY, and a throw from a
// `finally` block would replace the assertion that actually failed. So a
// cleanup failure during a failing test is swallowed and the directory is left
// behind, while a cleanup failure after a passing test still fails the test —
// a leaked handle is a real problem, not noise.
export async function withTmpDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    const result = await fn(dir);
    await rm(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Left behind on purpose: the real failure is rethrown below.
    }
    throw error;
  }
}
