import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export type User = { id: string; displayName: string; email?: string; role: 'admin' | 'member' };

export function upsertUserFromClaims(db: Db, c: { iss: string; sub: string; name?: string; email?: string; isAdmin: boolean }): User {
  const now = new Date().toISOString();
  const role: User['role'] = c.isAdmin ? 'admin' : 'member';
  const displayName = c.name?.trim() || c.email || c.sub;
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE iss = ? AND sub = ?').get(c.iss, c.sub) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare('UPDATE users SET display_name=?, email=?, role=?, last_login=? WHERE id=?').run(displayName, c.email ?? null, role, now, id);
    } else {
      db.prepare('INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, c.iss, c.sub, displayName, c.email ?? null, role, now, now);
    }
    return { id, displayName, ...(c.email ? { email: c.email } : {}), role };
  })();
}

export function getUser(db: Db, id: string): User | undefined {
  const r = db.prepare('SELECT id, display_name AS displayName, email, role FROM users WHERE id = ?').get(id) as
    { id: string; displayName: string; email: string | null; role: 'admin' | 'member' } | undefined;
  return r && { id: r.id, displayName: r.displayName, ...(r.email ? { email: r.email } : {}), role: r.role };
}
