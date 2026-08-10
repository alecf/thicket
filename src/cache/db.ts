import { mkdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ShapedFragment } from "../fingerprint/shape.js";
import { compareStrings } from "../order.js";

/**
 * Bumped whenever the row format changes. A cache written by a different
 * version is dropped and rebuilt rather than read: an older thicket reading a
 * newer database (or the reverse) is exactly the situation where a cache
 * silently changes the answer.
 */
export const CACHE_SCHEMA_VERSION = 2;

/** Gitignored already; `thicket cache clear` empties it. */
const CACHE_DIR = ".thicket";
const CACHE_FILE = "cache.db";

export function cachePathFor(root: string): string {
  return join(root, CACHE_DIR, CACHE_FILE);
}

/**
 * One physical fragment is one row, carrying **both** normalization hashes.
 *
 * Storing L0 and L1 as separate rows keyed by their own hash — the obvious
 * content-addressed layout — loses the association between the two levels of
 * the *same* fragment, and the L1 suppression rule needs exactly that. The
 * resulting cache would emit L1 findings that a cold run suppresses.
 *
 * The key is `(path, seq)`, not `(path, start, end)`: two AST nodes can share
 * a byte range exactly. `const x = f(a, b)` with no semicolon gives a
 * VariableStatement and a VariableDeclarationList with identical bounds, and
 * both are real fragments. Keyed on the range, one of them disappears on the
 * cached path only.
 *
 * `seq` is the emission ordinal within the file, so reading rows back
 * `ORDER BY seq` reproduces the walk order exactly. Cluster ties are broken by
 * a stable sort, which makes that order observable in the report.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fragment_occurrence (
  path TEXT NOT NULL,
  seq INTEGER NOT NULL,
  "start" INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  parent_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  l0_hash TEXT NOT NULL,
  l1_hash TEXT NOT NULL,
  PRIMARY KEY (path, seq)
);
`;

export interface Cache {
  /** True when this exact content was analyzed under this exact config. */
  isUnchanged(path: string, contentHash: string): boolean;
  /** The file's fragments in walk order. Empty when it is not cached. */
  fragmentsOf(path: string): ShapedFragment[];
  /** Atomically swaps in a file's fragments and its content hash. */
  replaceFile(path: string, contentHash: string, fragments: readonly ShapedFragment[]): void;
  /** Drops every file not in `paths`. Returns how many were dropped. */
  purgeExcept(paths: readonly string[]): number;
  close(): void;
}

/**
 * Open (or repair, or recreate) the cache at `path`.
 *
 * Returns `null` instead of throwing when the cache cannot be opened at all.
 * A cache is an optimization; it must never be the reason a report cannot be
 * produced, so every failure mode here degrades to "analyze everything".
 */
export function openCache(path: string, configHash: string): Cache | null {
  const db = openDatabase(path, configHash);
  if (!db) return null;

  const selectFile = db.prepare("SELECT content_hash FROM file WHERE path = ?");
  const selectFragments = db.prepare(
    `SELECT "start", "end", line, end_line, parent_id, kind, node_count, l0_hash, l1_hash
       FROM fragment_occurrence WHERE path = ? ORDER BY seq`,
  );
  const insertFile = db.prepare("INSERT OR REPLACE INTO file (path, content_hash) VALUES (?, ?)");
  const deleteFile = db.prepare("DELETE FROM file WHERE path = ?");
  const deleteFragments = db.prepare("DELETE FROM fragment_occurrence WHERE path = ?");
  const insertFragment = db.prepare(
    `INSERT INTO fragment_occurrence
       (path, seq, "start", "end", line, end_line, parent_id, kind, node_count, l0_hash, l1_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectPaths = db.prepare("SELECT path FROM file");

  // A cache that starts failing mid-run (another process holding a write lock
  // past the busy timeout, a full disk, a read-only checkout) stops being used
  // rather than taking the run down with it. Reads then answer "not cached",
  // which is always a safe answer.
  let broken = false;
  function guard<T>(fallback: T, body: () => T): T {
    if (broken) return fallback;
    try {
      return body();
    } catch {
      broken = true;
      return fallback;
    }
  }

  return {
    isUnchanged: (p, contentHash) =>
      guard(false, () => {
        const row = selectFile.get(p) as { content_hash: string } | undefined;
        return row?.content_hash === contentHash;
      }),

    fragmentsOf: (p) =>
      guard<ShapedFragment[]>([], () =>
        // `all()` is typed as bare column bags; the column list two dozen
        // lines up is what actually fixes the shape.
        (selectFragments.all(p) as unknown as FragmentRow[]).map((r) => ({
          filePath: p,
          kind: r.kind,
          nodeCount: Number(r.node_count),
          start: Number(r.start),
          end: Number(r.end),
          line: Number(r.line),
          endLine: Number(r.end_line),
          parentId: Number(r.parent_id),
          l0: r.l0_hash,
          l1: r.l1_hash,
        })),
      ),

    replaceFile: (p, contentHash, fragments) =>
      guard(undefined, () => {
        // One transaction per file: a half-written file must never be readable
        // as a whole one, and a run interrupted between files still leaves the
        // files it did finish usable.
        db.exec("BEGIN IMMEDIATE");
        try {
          deleteFragments.run(p);
          for (const [seq, f] of fragments.entries()) {
            insertFragment.run(
              p,
              seq,
              f.start,
              f.end,
              f.line,
              f.endLine,
              f.parentId,
              f.kind,
              f.nodeCount,
              f.l0,
              f.l1,
            );
          }
          insertFile.run(p, contentHash);
          db.exec("COMMIT");
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction is already gone; nothing to undo.
          }
          throw err;
        }
      }),

    purgeExcept: (paths) =>
      guard(0, () => {
        const keep = new Set(paths);
        const stale = (selectPaths.all() as { path: string }[])
          .map((r) => r.path)
          .filter((p) => !keep.has(p))
          .sort(compareStrings);
        if (stale.length === 0) return 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const p of stale) {
            deleteFragments.run(p);
            deleteFile.run(p);
          }
          db.exec("COMMIT");
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Already rolled back.
          }
          throw err;
        }
        return stale.length;
      }),

    close: () => {
      try {
        db.close();
      } catch {
        // Closing a database that already failed is not worth a crash.
      }
    },
  };
}

interface FragmentRow {
  start: number;
  end: number;
  line: number;
  end_line: number;
  parent_id: number;
  kind: string;
  node_count: number;
  l0_hash: string;
  l1_hash: string;
}

/**
 * Delete the cache. Returns whether anything was there to delete.
 *
 * Removes the sidecars too: a `-wal` left beside a deleted database is a set
 * of committed transactions waiting to be replayed into the next one.
 */
export function clearCache(root: string): boolean {
  const path = cachePathFor(root);
  let existed = false;
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      rmSync(p);
      existed ||= p === path;
    } catch {
      // Absent, or not ours to delete. Either way there is nothing to report.
    }
  }
  try {
    // Leave nothing behind if the cache was all `.thicket/` held. Non-empty is
    // the expected outcome once anything else lives there, and rmdir says so.
    rmdirSync(dirname(path));
  } catch {
    // Not empty, or never existed.
  }
  return existed;
}

/**
 * Open the database, rebuilding it when what is on disk is unusable.
 *
 * Three ways a cache file goes bad, all handled the same way — throw it away:
 * truncated or garbage bytes (a killed process, a bad copy), a schema from a
 * different thicket version, and a stale `config_hash`.
 */
function openDatabase(path: string, configHash: string): DatabaseSync | undefined {
  const inMemory = path === ":memory:";
  if (!inMemory) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      return undefined;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      initialize(db, configHash);
      return db;
    } catch {
      try {
        db?.close();
      } catch {
        // Nothing usable to close.
      }
      // A corrupt file is only recoverable by deletion, and there is nothing
      // in it worth keeping — every row is derived from source we still have.
      if (inMemory || attempt > 0) return undefined;
      for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        try {
          rmSync(p);
        } catch {
          // Not present; the retry will find out whether that was the problem.
        }
      }
    }
  }
  return undefined;
}

function initialize(db: DatabaseSync, configHash: string): void {
  // WAL lets a second thicket read while this one writes. `synchronous` drops
  // to NORMAL because the worst case for a cache losing its last transaction
  // is re-walking a file.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Two runs over one repo is a normal thing to do (an editor and a terminal).
  // Without this, the loser of a write race gets SQLITE_BUSY immediately.
  db.exec("PRAGMA busy_timeout = 5000");

  const version = readMeta(db, "schema_version");
  if (version !== undefined && version !== String(CACHE_SCHEMA_VERSION)) {
    dropEverything(db);
  }
  db.exec(SCHEMA);
  writeMeta(db, "schema_version", String(CACHE_SCHEMA_VERSION));

  // Thresholds and normalization rules are baked into the stored hashes, so a
  // config change makes every derived row meaningless — including the file
  // gate, whose whole claim is "this content was analyzed THIS way".
  if (readMeta(db, "config_hash") !== configHash) {
    db.exec("DELETE FROM fragment_occurrence; DELETE FROM file;");
    writeMeta(db, "config_hash", configHash);
  }
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined; // no meta table yet — a fresh or foreign database
  }
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * Drop every object in the database, not merely the tables this version knows
 * about. A newer thicket may have left tables whose names we cannot guess, and
 * leaving them behind means the file never shrinks.
 */
function dropEverything(db: DatabaseSync): void {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string }[];
  for (const { type, name } of objects) {
    if (type !== "table" && type !== "index" && type !== "view" && type !== "trigger") continue;
    // Dropping a table drops its indexes, so an index named here may already
    // be gone by the time we reach it.
    try {
      db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name.replace(/"/g, '""')}"`);
    } catch {
      // Leaving one object behind is survivable; failing the run is not.
    }
  }
}
