import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApproval } from "../src/contracts/index.ts";
import {
  appendRevision,
  createCommandSchema,
  createDeliverySchema,
  createDocument,
  createStore,
  deliverArticle,
  openStore,
  pendingExports,
  reconcileExports,
  rowCount,
} from "../src/storage/index.ts";

// W-02 conformance for `deliverArticle`: the approval-gated write joined to its
// external export, against the two frozen rules that span modules — the
// approval gate (§1, B.9) and the export living outside the transaction (B.10).

const AUTHOR = "author";
const AGENT = "agent";

function approvalFor(articleId, finalRevisionId, actor = AUTHOR) {
  const created = createApproval({
    actor,
    action: "article.deliver",
    target: articleId,
    targetVersion: finalRevisionId,
    decision: "approved",
    at: "2026-11-18T00:00:00Z",
  });
  assert.equal(created.ok, true);
  return created.ok ? created.record : null;
}

/** A writer that records what it was asked to write, or fails on demand. */
function recordingWriter(failWith) {
  const written = [];
  return {
    written,
    write(payload) {
      if (failWith) throw failWith;
      written.push(payload);
    },
  };
}

async function withDelivery(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-deliver-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createCommandSchema(db);
  createDeliverySchema(db);
  createDocument(db, "article-1");
  appendRevision(db, { revisionId: "final-1", documentId: "article-1", body: "正文", createdAt: 1 });
  try {
    return await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function request(db, overrides = {}) {
  return {
    actor: AUTHOR,
    articleId: "article-1",
    finalRevisionId: "final-1",
    approval: approvalFor("article-1", "final-1"),
    baseRevisionId: "final-1",
    idempotencyKey: "deliver-1",
    ...overrides,
  };
}

test("W-02 a delivery with a matching approval commits and then exports outside the transaction", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    const outcome = deliverArticle(db, request(db), writer.write);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.code, null);
    assert.equal(outcome.result.articleId, "article-1");
    assert.deepEqual(outcome.result.export, {
      state: "exported",
      hash: outcome.result.export.hash,
      wrote: true,
      retryable: null,
    });
    // The delivery row and the journal row committed together.
    assert.equal(rowCount(db, "deliveries"), 1);
    assert.equal(rowCount(db, "command_journal"), 1);
    // The external write received the delivery's payload.
    assert.equal(writer.written.length, 1);
    assert.equal(writer.written[0], "article-1\nfinal-1\n2026-11-18T00:00:00Z\n");
  });
});

test("W-02 a delivery without a matching approval is refused before anything is written", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    const outcome = deliverArticle(db, request(db, { approval: null }), writer.write);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "gate.denied");
    assert.equal(outcome.details.reason, "approval-missing");
    // Neither the delivery nor the journal row exists, and nothing was exported.
    assert.equal(rowCount(db, "deliveries"), 0);
    assert.equal(rowCount(db, "command_journal"), 0);
    assert.equal(writer.written.length, 0);
  });
});

test("W-02 an approval for another revision or another subject grants nothing", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    // The approval names a different revision than the one being delivered.
    const wrongVersion = deliverArticle(
      db,
      request(db, { approval: approvalFor("article-1", "final-0") }),
      writer.write,
    );
    assert.equal(wrongVersion.code, "gate.denied");
    // An approval another subject obtained does not transfer.
    const wrongActor = deliverArticle(
      db,
      request(db, { approval: approvalFor("article-1", "final-1", AGENT) }),
      writer.write,
    );
    assert.equal(wrongActor.code, "gate.denied");
    assert.equal(rowCount(db, "deliveries"), 0);
    assert.equal(writer.written.length, 0);
  });
});

test("W-02 the writing Agent is refused before the approval gate is consulted", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    const outcome = deliverArticle(
      db,
      request(db, { actor: AGENT, approval: null }),
      writer.write,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "auth.denied");
    assert.equal(outcome.details.actor, AGENT);
    assert.equal(rowCount(db, "deliveries"), 0);
  });
});

test("W-02 a failed export leaves the delivery committed and the export retryable", async () => {
  await withDelivery((db) => {
    // A transient failure: the delivery still commits, the export stays pending.
    const failing = recordingWriter(new Error("disk full"));
    const outcome = deliverArticle(db, request(db), failing.write);

    assert.equal(outcome.ok, true, "a failed export must not fail the delivery");
    assert.equal(outcome.result.export.state, "failed");
    assert.equal(outcome.result.export.retryable, true);
    assert.equal(rowCount(db, "deliveries"), 1);
    assert.equal(rowCount(db, "command_journal"), 1);

    // The delivery sits in the pending worklist, waiting for a retry.
    const worklist = pendingExports(db);
    assert.deepEqual(worklist, ["article-1"]);
    assert.deepEqual(reconcileExports(db), { pending: ["article-1"], needsAuthor: [] });

    // A retry with a working writer completes it without a second delivery row.
    const working = recordingWriter(null);
    const retried = deliverArticle(db, request(db), working.write);
    assert.equal(retried.ok, true);
    assert.equal(retried.result.export.state, "exported");
    assert.equal(working.written.length, 1);
    assert.equal(rowCount(db, "deliveries"), 1);
    assert.deepEqual(pendingExports(db), []);
  });
});

test("W-02 a non-retryable export failure leaves the worklist and waits for the author", async () => {
  await withDelivery((db) => {
    // A conflicting target is the author's to resolve, so the failure carries
    // `retryable: false` and the delivery leaves the retry worklist.
    const conflict = Object.assign(new Error("export target already exists"), { retryable: false });
    const outcome = deliverArticle(db, request(db), () => {
      throw conflict;
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.export.state, "failed");
    assert.equal(outcome.result.export.retryable, false);
    assert.equal(rowCount(db, "deliveries"), 1);

    const worklist = reconcileExports(db);
    assert.deepEqual(worklist.pending, []);
    assert.deepEqual(worklist.needsAuthor, ["article-1"]);
    // It is out of the retry worklist, so a restart does not retry it.
    assert.deepEqual(pendingExports(db), []);
  });
});

test("W-02 a replayed delivery runs the command's work once and reports the export it reached", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    const first = deliverArticle(db, request(db), writer.write);
    assert.equal(first.replayed, false);

    // The same request replays through the journal: the delivery row is not
    // inserted again, and the export returns early rather than rewriting.
    const replay = deliverArticle(db, request(db), writer.write);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.export.state, "exported");
    assert.equal(replay.result.export.wrote, false, "an already-exported delivery does not rewrite");
    assert.equal(writer.written.length, 1);
    assert.equal(rowCount(db, "deliveries"), 1);
  });
});

test("W-02 a delivery after a restart reconciles its unfinished export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-deliverrestart-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const first = openStore(path);
  createCommandSchema(first);
  createDeliverySchema(first);
  createDocument(first, "article-1");
  appendRevision(first, { revisionId: "final-1", documentId: "article-1", body: "正文", createdAt: 1 });
  try {
    // The delivery commits, the export fails, and the process goes away.
    const failing = recordingWriter(new Error("disk full"));
    const outcome = deliverArticle(first, request(first), failing.write);
    assert.equal(outcome.result.export.state, "failed");
    first.close();

    // After the restart the worklist still names the delivery, and a retry
    // completes it from the committed row.
    const second = openStore(path);
    try {
      const worklist = pendingExports(second);
      assert.deepEqual(worklist, ["article-1"]);
      const working = recordingWriter(null);
      const retried = deliverArticle(second, request(second), working.write);
      assert.equal(retried.result.export.state, "exported");
      assert.equal(working.written.length, 1);
      assert.deepEqual(reconcileExports(second), { pending: [], needsAuthor: [] });
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W-02 delivering the same article twice is a version conflict, not a duplicate row", async () => {
  await withDelivery((db) => {
    const writer = recordingWriter(null);
    const first = deliverArticle(db, request(db), writer.write);
    assert.equal(first.ok, true);

    // A different key for the same article: the delivery already exists, so the
    // second is refused rather than inserting a second row.
    const second = deliverArticle(
      db,
      request(db, { idempotencyKey: "deliver-2", finalRevisionId: "final-2", approval: approvalFor("article-1", "final-2") }),
      writer.write,
    );
    assert.equal(second.ok, false);
    assert.equal(second.code, "version.conflict");
    assert.equal(second.details.documentId, "article-1");
    assert.equal(second.details.currentRevisionId, "final-1");
    assert.equal(rowCount(db, "deliveries"), 1);
  });
});
