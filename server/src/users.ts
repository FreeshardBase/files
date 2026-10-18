import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export type User = { id: string; displayName: string; email?: string; role: 'admin' | 'member' };

/**
 * #337: `name`, then `preferred_username`, then the email's local part. With none of them the name stays empty and the
 * web shows the localized "Mitglied" (`web/src/memberName.ts`); never the internal id or `sub`.
 */
function displayNameFromClaims(c: { name?: string; preferredUsername?: string; email?: string }): string {
  return c.name?.trim() || c.preferredUsername?.trim() || c.email?.split('@')[0]?.trim() || '';
}

export function upsertUserFromClaims(db: Db, c: { iss: string; sub: string; name?: string; preferredUsername?: string;
  email?: string; isAdmin: boolean }): User {
  const now = new Date().toISOString();
  const role: User['role'] = c.isAdmin ? 'admin' : 'member';
  // Taken at every login, so a changed claim reaches every place the member is shown.
  const displayName = displayNameFromClaims(c);
  const login = c.preferredUsername?.trim() || c.email?.trim() || null;
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE iss = ? AND sub = ?').get(c.iss, c.sub) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare('UPDATE users SET display_name=?, email=?, login=?, role=?, last_login=? WHERE id=?')
        .run(displayName, c.email ?? null, login, role, now, id);
    } else {
      db.prepare('INSERT INTO users (id, iss, sub, display_name, email, login, role, created_at, last_login) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, c.iss, c.sub, displayName, c.email ?? null, login, role, now, now);
    }
    return { id, displayName, ...(c.email ? { email: c.email } : {}), role };
  })();
}

/**
 * #321: the member's login name (`preferred_username`, else the email), the user name on the phone setup page. Only the
 * member sees it (`/api/v1/me`); `User` does not carry it, so no list of members shows it.
 */
export function loginOf(db: Db, id: string): string | undefined {
  const r = db.prepare('SELECT login FROM users WHERE id = ?').get(id) as { login: string | null } | undefined;
  return r?.login ?? undefined;
}

export function getUser(db: Db, id: string): User | undefined {
  const r = db.prepare('SELECT id, display_name AS displayName, email, role FROM users WHERE id = ?').get(id) as
    { id: string; displayName: string; email: string | null; role: 'admin' | 'member' } | undefined;
  return r && { id: r.id, displayName: r.displayName, ...(r.email ? { email: r.email } : {}), role: r.role };
}
