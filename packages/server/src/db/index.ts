import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin, dependency-free wrapper around the SQLite engine bundled with Node 22
 * (`node:sqlite`). It is deliberately synchronous: every wallet mutation runs
 * inside a `BEGIN IMMEDIATE` transaction, which removes a whole class of race
 * conditions that async drivers introduce.
 */

export type SqlValue = string | number | bigint | null;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class Database {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA temp_store = MEMORY;');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Normalises `undefined` -> `null` (node:sqlite rejects undefined binds). */
  private static norm(args: unknown[]): SqlValue[] {
    return args.map((a) => {
      if (a === undefined) return null;
      if (a === null) return null;
      if (typeof a === 'boolean') return a ? 1 : 0;
      if (a instanceof Date) return a.toISOString();
      if (typeof a === 'object') return JSON.stringify(a);
      return a as SqlValue;
    });
  }

  get<T = Record<string, any>>(sql: string, ...args: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(Database.norm(args) as any)) as T | undefined;
  }

  all<T = Record<string, any>>(sql: string, ...args: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(Database.norm(args) as any)) as T[];
  }

  run(sql: string, ...args: unknown[]): RunResult {
    const r = this.raw.prepare(sql).run(...(Database.norm(args) as any)) as any;
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** First column of the first row — handy for counts. */
  scalar<T = number>(sql: string, ...args: unknown[]): T | undefined {
    const row = this.all<Record<string, unknown>>(sql, ...args)[0];
    if (!row) return undefined;
    const key = Object.keys(row)[0];
    return (key ? row[key] : undefined) as T | undefined;
  }

  /**
   * Runs `fn` inside an IMMEDIATE transaction. IMMEDIATE takes the write lock
   * up front, so two concurrent "read balance then debit" flows cannot both
   * succeed — this is the backbone of double-spend prevention.
   * Nested calls join the outer transaction (savepoints).
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}_${Date.now().toString(36)}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.txDepth += 1;
      try {
        const out = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (err) {
        try {
          this.raw.exec(`ROLLBACK TO ${sp}`);
          this.raw.exec(`RELEASE ${sp}`);
        } catch {
          /* ignore */
        }
        this.txDepth -= 1;
        throw err;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}

let instance: Database | null = null;

export function getDb(): Database {
  if (!instance) throw new Error('Database has not been initialised. Call initDb() first.');
  return instance;
}

export function initDb(filename: string): Database {
  instance = new Database(filename);
  return instance;
}

export function setDb(db: Database): void {
  instance = db;
}

export function hasDb(): boolean {
  return instance !== null;
}
