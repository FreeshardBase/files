// The words for a source's name rules (#342, shared/src/nameRules.ts): why a name is refused there.
import { GRAPH_MAX_PATH, checkName, type NameIssue, type NameRuleSet } from '@files/shared';

type T = (key: string, params?: Record<string, unknown>) => string;

/** One issue as a sentence: "„:“ ist bei OneDrive nicht erlaubt." */
export function issueText(t: T, set: NameRuleSet, issue: NameIssue): string {
  return t(`nameRules.issue.${issue.code}`, { provider: t(`nameRules.provider.${set}`), char: issue.char ?? '', max: GRAPH_MAX_PATH });
}

/** Why `name` may not be created in `dir`, or null if it may. */
export function nameRefusal(t: T, set: NameRuleSet, name: string, dir: string): string | null {
  const issues = checkName(set, name, dir);
  return issues.length ? issues.map((i) => issueText(t, set, i)).join(' ') : null;
}
