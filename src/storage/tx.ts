import type { SqliteDatabase } from "./driver.ts";
import { StorageError } from "./errors.ts";

interface TxState {
  depth: number;
  readonly mode: "read" | "write";
  savepointSeq: number;
}

const txStates = new WeakMap<SqliteDatabase, TxState>();

/** Reports the active transaction mode on `db`, or `null` outside a transaction. */
export function inTransaction(db: SqliteDatabase): "read" | "write" | null {
  return txStates.get(db)?.mode ?? null;
}

/**
 * Executes `fn` inside a write transaction (`BEGIN IMMEDIATE`), using SQLite
 * `SAVEPOINT` for nested calls and refusing writes inside an active read tx.
 */
export function withWriteTx<T>(db: SqliteDatabase, fn: () => T): T {
  const existing = txStates.get(db);
  if (!existing) {
    db.exec("BEGIN IMMEDIATE;");
    txStates.set(db, { depth: 1, mode: "write", savepointSeq: 0 });
    try {
      const result = fn();
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the original failure rather than masking it with rollback errors.
      }
      throw error;
    } finally {
      txStates.delete(db);
    }
  }

  if (existing.mode === "read") {
    throw new StorageError("gate.denied", {
      action: "storage.tx",
      reason: "write-inside-read-tx",
    });
  }

  existing.depth += 1;
  existing.savepointSeq += 1;
  const sp = `zz_sp_${existing.savepointSeq}`;
  db.exec(`SAVEPOINT ${sp};`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${sp};`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
    } catch {
      // Preserve the original failure rather than masking it with savepoint rollback errors.
    }
    throw error;
  } finally {
    existing.depth -= 1;
  }
}

/**
 * Executes `fn` inside a read transaction (`BEGIN`), joining any active read or
 * write transaction cleanly without downgrading write permissions.
 */
export function withReadTx<T>(db: SqliteDatabase, fn: () => T): T {
  const existing = txStates.get(db);
  if (existing) {
    existing.depth += 1;
    try {
      return fn();
    } finally {
      existing.depth -= 1;
    }
  }

  db.exec("BEGIN;");
  txStates.set(db, { depth: 1, mode: "read", savepointSeq: 0 });
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    txStates.delete(db);
  }
}
