import { afterAll, beforeAll, expect, it } from 'vitest';
import { createVitest, type Vitest } from 'vitest/node';
import { fileURLToPath } from 'node:url';

// #318: the load test measures event-loop stalls, so it must not share the CPU with other test files (the 2 GB tus
// upload made it fail on a busy runner). Vitest runs groups one after another; the load test needs a group of its own
// that starts after every other file.

const root = fileURLToPath(new URL('..', import.meta.url));
let v: Vitest;
beforeAll(async () => {
  v = await createVitest('test', { root, config: 'vitest.config.ts', watch: false, run: false }, {}, {});
}, 30_000);
afterAll(async () => { await v?.close(); });

it('runs the load test alone, after every other test file', async () => {
  const specs = await v.globTestSpecifications();
  const groupOf = (s: (typeof specs)[number]) => s.project.config.sequence.groupOrder;
  const load = specs.filter((s) => s.moduleId.endsWith('/test/load.test.ts'));
  const others = specs.filter((s) => !s.moduleId.endsWith('/test/load.test.ts'));
  expect(load).toHaveLength(1);
  expect(others.length).toBeGreaterThan(50);
  for (const s of others) expect(groupOf(s)).toBeLessThan(groupOf(load[0]!));
}, 30_000);
