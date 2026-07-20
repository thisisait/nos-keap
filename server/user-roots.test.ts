import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * User-defined taxonomy roots (slug ids, e.g. `nos`) — the two holes that blocked
 * a first-tier node, exercised against a real throwaway libSQL DB.
 *
 * Both failed CLOSED and silently, which is why this is unit-tested rather than
 * left to the e2e: `registerExtNode` returned null for any parentless row, and
 * `appendExtNodeToLayout` returned false because it demanded a parent position —
 * so a root got no coordinate, and a node without a coordinate has every one of
 * its cards skipped by the client (`star.x === undefined`).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-roots-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tax: typeof import('./taxonomy');
let layout: typeof import('./layout');

beforeAll(async () => {
  db = await import('./db');
  tax = await import('./taxonomy');
  layout = await import('./layout');
  await db.initDb();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ROOT = { id: 'nos', parentId: '', name: 'nOS', description: 'Platform self-model.', zone: 'free' };

describe('registerExtNode — user-defined roots', () => {
  it('accepts a parentless node inside the reserved range', () => {
    const n = tax.registerExtNode(ROOT);
    expect(n).not.toBeNull();
    expect(n!.parentId).toBeNull();
    // A root is a category, like the seed domains beside it — 'item' would draw
    // a whole domain with the visual weight of a leaf.
    expect(n!.kind).toBe('category');
    expect(n!.path).toBe('');
    expect(n!.ext).toBe(true);
  });

  it('refuses a parentless node that is not a bare slug', () => {
    // Unrestricted parentless nodes would be indistinguishable from a grown node
    // whose parent failed to resolve — exactly the silent orphan the parent check
    // exists to catch.
    expect(tax.registerExtNode({ ...ROOT, id: '42' })).toBeNull();   // numeric = seed shape
    expect(tax.registerExtNode({ ...ROOT, id: 'nos.infra' })).toBeNull(); // not a ROOT
    expect(tax.registerExtNode({ ...ROOT, id: 'NOS' })).toBeNull();  // charset
  });

  it('cannot hijack a seed domain id', () => {
    // Registration is idempotent by id, so '01' returns the EXISTING seed
    // domain untouched rather than redefining it as a user root.
    const n = tax.registerExtNode({ ...ROOT, id: '01', name: 'Hijacked' });
    expect(n!.name).toBe('Natural Sciences');
    expect(n!.ext).toBeUndefined();
  });

  it('still refuses a non-root whose parent does not resolve', () => {
    expect(tax.registerExtNode({ ...ROOT, id: 'nos.ghost.child', parentId: 'nos.ghost' })).toBeNull();
  });

  it('hangs children off the root normally', () => {
    const stack = tax.registerExtNode({
      id: 'nos.infra', parentId: 'nos', name: 'infra', description: 'Infra stack.', zone: 'free',
    });
    expect(stack).not.toBeNull();
    expect(stack!.parentId).toBe('nos');
    expect(tax.getNode('nos')!.childIds).toContain('nos.infra');
    // path builds from the root's name even though the root's own path is ''.
    expect(stack!.path).toBe('nOS');
  });
});

describe('appendExtNodeToLayout — root placement', () => {
  it('gives a root a position without needing a parent', () => {
    expect(layout.appendExtNodeToLayout({ id: 'nos', parentId: '', ordinal: 0 })).toBe(true);
    const p = db.getLayout().get('nos');
    expect(p).toBeTruthy();
    expect(Number.isFinite(p!.x) && Number.isFinite(p!.y) && Number.isFinite(p!.z)).toBe(true);
  });

  it('places the root OUTSIDE the seed ring', () => {
    const p = db.getLayout().get('nos')!;
    // Seed domains sit at r=1400; a user root must not land among them or its
    // whole subtree reads as part of whichever domain it landed next to.
    const r = Math.hypot(p.x, p.y);
    expect(r).toBeGreaterThan(1400 * 1.5);
  });

  it('a second root does not move the first', () => {
    // The property index-based placement cannot have: position is fixed by the
    // root's own name, so adding a sibling root disturbs nothing.
    const before = db.getLayout().get('nos')!;
    tax.registerExtNode({ id: 'lab', parentId: '', name: 'Lab', description: 'Another root.', zone: 'free' });
    expect(layout.appendExtNodeToLayout({ id: 'lab', parentId: '', ordinal: 0 })).toBe(true);
    const after = db.getLayout().get('nos')!;
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(db.getLayout().get('lab')!.x).not.toBe(before.x);
  });

  it('refuses a parentless node outside the range, rather than placing it anywhere', () => {
    expect(layout.appendExtNodeToLayout({ id: '42', parentId: '', ordinal: 0 })).toBe(false);
  });

  it('places a child once its root is placed', () => {
    expect(layout.appendExtNodeToLayout({ id: 'nos.infra', parentId: 'nos', ordinal: 0 })).toBe(true);
    const p = db.getLayout().get('nos.infra');
    expect(p).toBeTruthy();
    // The child orbits its root, not the galaxy centre.
    const root = db.getLayout().get('nos')!;
    expect(Math.hypot(p!.x - root.x, p!.y - root.y)).toBeLessThan(600);
  });
});
