// The last folder chosen in "Move to…" / "Copy to…" (#339), per member on this device only; the picker offers it first.
export type Target = { source: string; path: string };

const key = (member: string) => `files:moveTarget:${member}`;

export function rememberTarget(member: string, target: Target): void {
  localStorage.setItem(key(member), JSON.stringify(target));
}

export function lastTarget(member: string): Target | null {
  const raw = localStorage.getItem(key(member));
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; } // handled: a damaged entry counts as none; the next choice overwrites it
  const v = value as Partial<Target> | null;
  return v && typeof v.source === 'string' && typeof v.path === 'string' && v.path.startsWith('/')
    ? { source: v.source, path: v.path } : null;
}
