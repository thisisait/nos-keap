import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The graph leg must never hand an UPWARD hop a better rank than a downward
 * one. The leg's rank IS its RRF weight, and the old iteration order pushed
 * the parent FIRST per seed — so the #1 seed's parent took graph-rank 1 for
 * merely existing. A parent is reachable from every sibling seed while a card
 * can never receive graph help, so stack-level ancestors systematically
 * outranked the specific answer by 1-2 slots — the _stack.md failure class
 * arising from inside the ranker, caught by the recall gate's forbid half
 * ("read time-series data", "which containers are logging", 2026-09-05).
 *
 * Behavioural over the REAL taxonomy tree; the live recall gate is the
 * end-to-end proof that the two red cases flip.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-hop-'));
process.env.KEAP_DATA_DIR = TMP;

let search: typeof import('./search');
let taxonomy: typeof import('./taxonomy');

beforeAll(async () => {
  const db = await import('./db');
  await db.initDb();
  search = await import('./search');
  taxonomy = await import('./taxonomy');
});

type Seed = { kind: 'taxonomy'; refId: string };

function nodeWithParentAndChildren(): { id: string; parentId: string; childIds: string[] } {
  const n = taxonomy
    .allNodes()
    .find((x) => x.parentId && x.childIds.length >= 2);
  expect(n, 'no taxonomy node with both a parent and children — dataset changed shape?').toBeDefined();
  return n as never;
}

describe('the graph leg ranks downward hops before upward ones', () => {
  it('a single seed lists its children before its parent', () => {
    const n = nodeWithParentAndChildren();
    const hops = search.orderedHops([{ kind: 'taxonomy', refId: n.id } as Seed]);
    const ids = hops.map((h) => h.refId);
    const parentAt = ids.indexOf(n.parentId);
    expect(parentAt, 'the parent vanished from the hop set').toBeGreaterThan(-1);
    for (const c of n.childIds.slice(0, 5)) {
      expect(ids.indexOf(c)).toBeLessThan(parentAt);
    }
  });

  it('NO seed’s parent precedes ANY seed’s downward hop (the cross-seed law)', () => {
    const nodes = taxonomy
      .allNodes()
      .filter((x) => x.parentId && x.childIds.length >= 1)
      .slice(0, 4);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const seeds = nodes.map((n) => ({ kind: 'taxonomy', refId: n.id }) as Seed);
    const hops = search.orderedHops(seeds);
    const parents = new Set(nodes.map((n) => n.parentId));
    let sawParent = false;
    for (const h of hops) {
      if (parents.has(h.refId)) sawParent = true;
      else
        expect(
          sawParent,
          `downward hop ${h.refId} ranked after an upward hop — the parent boost is back`,
        ).toBe(false);
    }
  });

  it('seeds themselves are never re-emitted as hops', () => {
    const n = nodeWithParentAndChildren();
    const seeds: Seed[] = [
      { kind: 'taxonomy', refId: n.id },
      { kind: 'taxonomy', refId: n.parentId },
    ];
    const ids = search.orderedHops(seeds).map((h) => h.refId);
    expect(ids).not.toContain(n.id);
    expect(ids).not.toContain(n.parentId);
  });
});
