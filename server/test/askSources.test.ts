import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { mapLimit, withinTime } from '../src/storage/askSources.ts';

// #307: resolving many items of a source runs a few calls at a time, stops at the first failure and once nobody waits.
describe('mapLimit', () => {
  it('keeps at most n calls in flight and the items in order', async () => {
    let inFlight = 0; let peak = 0;
    // Later items answer sooner, so results in the order they settle would be out of order.
    const out = await mapLimit(Array.from({ length: 40 }, (_, i) => i), 3, async (i) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(i % 3 === 0 ? 6 : 1);
      inFlight--;
      return i * 2;
    });
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i * 2));
    expect(peak).toBe(3);
  });

  it('starts no further call after the first failure', async () => {
    const started: number[] = [];
    await expect(mapLimit(Array.from({ length: 40 }, (_, i) => i), 2, async (i) => {
      started.push(i);
      await sleep(1);
      if (i === 3) throw new Error('provider exploded');
    })).rejects.toThrow('provider exploded');
    await sleep(30);
    expect(started.length).toBeLessThanOrEqual(5);
  });

  it('starts no further call once the time limit has passed', async () => {
    const started: number[] = [];
    await expect(withinTime(20, (signal) => mapLimit(Array.from({ length: 100 }, (_, i) => i), 2, async (i) => {
      started.push(i);
      await sleep(10);
    }, signal))).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });
    const atTimeout = started.length;
    await sleep(100);
    expect(started.length).toBeLessThanOrEqual(atTimeout + 2);
    expect(started.length).toBeLessThan(20);
  });
});
