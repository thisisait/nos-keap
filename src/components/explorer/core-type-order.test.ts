import { describe, expect, it } from 'vitest';
import { computeCore, CORE_MAX, type CoreOrder } from './core';
import type { GraphObject } from '@/hooks/useExplorerData';

/**
 * The by-TYPE core order.
 *
 * WHY IT EXISTS. The other three orders group by PROVENANCE — where a thing
 * came from (`fs`), what it is about (`taxonomy`, `topic`). None answers "what
 * have I got", which is the question the core view is opened to ask. Before
 * this, core relocated every object into one undifferentiated ball and drew a
 * tether per object back across the whole scene: measured live at 322 objects,
 * that is a cable bundle, not a picture.
 *
 * The two properties worth pinning are not "it groups" — that is obvious from
 * reading it — but SPATIAL MEMORY (a new type must not rotate the existing ones
 * out from under the operator) and RAY COLLAPSE (the thing that made the old
 * view unreadable).
 */

function obj(id: string, assetType: string, anchors: string[] = [], hue = 95): GraphObject {
  return {
    id,
    title: id,
    type: assetType,
    assetType,
    form: 'station',
    glyph: 'skill',
    hue,
    anchors,
  } as GraphObject;
}

const OPTS = {
  unfiledLabel: 'Unfiled',
  untopicedLabel: 'Untopiced',
  galaxyOf: () => null,
  mappings: [],
  galaxyPosOf: () => null,
  topics: [],
};

const run = (objects: GraphObject[], order: CoreOrder = 'type') => computeCore(objects, order, OPTS);

describe('core order: type', () => {
  it('grows one hub per asset type, carrying that type’s own hue', () => {
    const out = run([
      obj('a', 'skill', [], 95),
      obj('b', 'skill', [], 95),
      obj('c', 'page', [], 220),
    ]);
    const hubs = out.folders.filter((f) => f.assetType);
    expect(hubs.map((h) => h.assetType).sort()).toEqual(['page', 'skill']);
    // The hub and the bodies inside it must read as ONE thing; a hub that
    // re-derived its own hue would say something different from its members.
    expect(hubs.find((h) => h.assetType === 'skill')!.hue).toBe(95);
    expect(hubs.find((h) => h.assetType === 'page')!.hue).toBe(220);
    expect(hubs.find((h) => h.assetType === 'skill')!.count).toBe(2);
  });

  it('places every object, and inside its own hub’s neighbourhood', () => {
    const out = run([obj('a', 'skill'), obj('b', 'page'), obj('c', 'table')]);
    for (const id of ['a', 'b', 'c']) expect(out.positions.has(`obj:${id}`)).toBe(true);

    const hub = out.positions.get('type:skill')!;
    const body = out.positions.get('obj:a')!;
    const d = Math.hypot(body[0] - hub[0], body[1] - hub[1], body[2] - hub[2]);
    expect(d).toBeLessThan(210); // the member sphere radius is capped at 200
  });

  it('keeps every body inside the ring’s clear zone', () => {
    const out = run(Array.from({ length: 60 }, (_, i) => obj(`o${i}`, i % 3 === 0 ? 'skill' : 'page')));
    for (const [, p] of out.positions) {
      expect(Math.hypot(p[0], p[1], p[2])).toBeLessThan(CORE_MAX + 200);
    }
  });

  it('SPATIAL MEMORY: adding a new type does not move the existing hubs', () => {
    // θ is frozen by a hash of the type NAME, not by its index — an
    // index-ordered ring would rotate every cluster out from under the
    // operator the first time a new asset type appeared in the corpus.
    const before = run([obj('a', 'skill'), obj('b', 'page')]);
    const after = run([obj('a', 'skill'), obj('b', 'page'), obj('c', 'audio')]);
    for (const t of ['skill', 'page']) {
      expect(after.positions.get(`type:${t}`)).toEqual(before.positions.get(`type:${t}`));
    }
  });

  it('is deterministic — same input, byte-identical placement', () => {
    const a = run([obj('x', 'skill'), obj('y', 'page')]);
    const b = run([obj('y', 'page'), obj('x', 'skill')]); // input order differs
    expect([...b.positions.entries()].sort()).toEqual([...a.positions.entries()].sort());
  });

  it('separates hubs whose name hashes land close together', () => {
    const out = run(['skill', 'page', 'table', 'audio', 'image', 'notes', 'wiki', 'blog'].map((t, i) => obj(`o${i}`, t)));
    const hubs = out.folders.filter((f) => f.assetType).map((f) => out.positions.get(f.id)!);
    for (let i = 0; i < hubs.length; i += 1) {
      for (let j = i + 1; j < hubs.length; j += 1) {
        const d = Math.hypot(hubs[i][0] - hubs[j][0], hubs[i][1] - hubs[j][1], hubs[i][2] - hubs[j][2]);
        expect(d).toBeGreaterThan(40); // no two clusters collapse into one blob
      }
    }
  });

  it('RAY COLLAPSE: below the threshold rays are per-object', () => {
    const out = run([obj('a', 'skill', ['01.01']), obj('b', 'skill', ['01.02'])]);
    expect(out.rays.map((r) => r.source).sort()).toEqual(['obj:a', 'obj:b']);
  });

  it('RAY COLLAPSE: past the threshold they aggregate to the hub', () => {
    // The whole point of the order. 250 anchored bodies must not each draw a
    // tether across the scene — that is the cable bundle it replaces.
    const many = Array.from({ length: 250 }, (_, i) => obj(`s${i}`, 'skill', ['01.01']));
    const out = run(many);
    expect(out.rays).toHaveLength(1);
    expect(out.rays[0]).toEqual({ source: 'type:skill', target: '01.01' });
  });

  it('an unanchored object contributes no ray at all', () => {
    const out = run([obj('a', 'skill'), obj('b', 'skill')]);
    expect(out.rays).toEqual([]);
  });

  it('links each body to its hub so the envelope has an edge to follow', () => {
    const out = run([obj('a', 'skill'), obj('b', 'page')]);
    expect(out.fsLinks).toContainEqual({ source: 'type:skill', target: 'obj:a' });
    expect(out.fsLinks).toContainEqual({ source: 'type:page', target: 'obj:b' });
  });

  it('leaves the other three orders untouched', () => {
    const objs = [obj('a', 'skill', ['01.01']), obj('b', 'page', ['01.02'])];
    for (const order of ['fs', 'taxonomy', 'topic'] as CoreOrder[]) {
      const out = run(objs, order);
      expect(out.folders.some((f) => f.assetType)).toBe(false);
      expect([...out.positions.keys()].some((k) => k.startsWith('type:'))).toBe(false);
    }
  });
});
