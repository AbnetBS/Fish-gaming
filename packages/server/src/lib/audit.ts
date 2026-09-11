import { uid } from './ids.js';
import type { Database } from '../db/index.js';
import type { AuditEntry } from '@reef/shared';

/**
 * Append-only audit trail.
 *
 * Every privileged mutation records who did it, what changed (before → after),
 * when, and from where. The table is protected by `BEFORE UPDATE` /
 * `BEFORE DELETE` triggers in `schema.sql`, so a compromised application
 * account still cannot rewrite history.
 */

export interface AuditInput {
  adminId: string | null;
  adminUsername?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: unknown;
  ip?: string | null;
}

export function writeAudit(db: Database, entry: AuditInput): string {
  const id = uid('aud');
  db.run(
    `INSERT INTO audit_logs (id, admin_id, admin_username, action, entity, entity_id, previous_value, new_value, metadata, ip_address, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    entry.adminId,
    entry.adminUsername ?? null,
    entry.action,
    entry.entity,
    entry.entityId ?? null,
    entry.previousValue === undefined ? null : stringify(entry.previousValue),
    entry.newValue === undefined ? null : stringify(entry.newValue),
    entry.metadata === undefined ? null : stringify(entry.metadata),
    entry.ip ?? null,
    new Date().toISOString(),
  );
  return id;
}

/** Diff two objects and return only the fields that actually changed. */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[key] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

export function readAudit(
  db: Database,
  params: { limit?: number; offset?: number; entity?: string; adminId?: string; action?: string },
): { items: AuditEntry[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.entity) {
    where.push('entity = ?');
    args.push(params.entity);
  }
  if (params.adminId) {
    where.push('admin_id = ?');
    args.push(params.adminId);
  }
  if (params.action) {
    where.push('action = ?');
    args.push(params.action);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.scalar<number>(`SELECT COUNT(*) FROM audit_logs ${clause}`, ...args) ?? 0;
  const items = db
    .all<any>(
      `SELECT id, admin_id, admin_username, action, entity, entity_id, previous_value, new_value, metadata, created_at
       FROM audit_logs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    )
    .map((r) => ({
      id: r.id,
      adminId: r.admin_id,
      adminUsername: r.admin_username,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      previousValue: r.previous_value,
      newValue: r.new_value,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  return { items, total };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
