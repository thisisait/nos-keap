import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Round-trip identity for a SLUG canonical tree — the shape the nOS self-model
 * epic will ship, which the repo's own canonical (numeric spine) never exercises:
 * a parentless root, dotted-slug ids, and a credential node at level 3.
 *
 * ingest(fixture) → dump → the dumped files must equal the source. The two
 * root-specific traps this pins: ingest must store the root's missing parentId
 * as the '' sentinel (the column is NOT NULL), and dump must OMIT parentId for
 * a root rather than emitting '' — else identity breaks against a source file
 * that leaves it out.
 */
const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'e2e', 'fixtures', 'selfmodel');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-slugrt-'));
const OUT = path.join(TMP, 'dump');

const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('node', [path.join(REPO, 'knowledge', script), ...args], {
    env: { ...process.env, KEAP_DATA_DIR: TMP, ...env },
    encoding: 'utf8',
  });

beforeAll(() => {
  run('roundtrip-setup.mjs', []);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

type CanonNode = { id: string; parentId?: string; [k: string]: unknown };
type CanonRel = { from: string; to: string; type: string };
const loadDir = (dir: string): { nodes: Map<string, CanonNode>; relations: CanonRel[] } => {
  const nodes = new Map<string, CanonNode>();
  const relations: CanonRel[] = [];
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (!f.endsWith('.json')) continue;
        const doc = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')) as {
          nodes: CanonNode[];
          relations?: CanonRel[];
        };
        for (const n of doc.nodes) nodes.set(n.id, n);
        for (const r of doc.relations ?? []) relations.push(r);
      }
    }
  }
  return { nodes, relations };
};

describe('slug canonical round-trip', () => {
  it('ingests the fixture, storing the root with the empty-parent sentinel', () => {
    const out = run('ingest.mjs', ['--canonical', FIXTURE]);
    expect(out).toContain('INGEST_RESULT');
    const result = JSON.parse(out.slice(out.indexOf('INGEST_RESULT') + 'INGEST_RESULT '.length));
    expect(result.applied.sort()).toEqual(['nos', 'nos.iiab', 'nos.infra']);
    expect(result.reidentified).toEqual([]);
  });

  it('dump reproduces the source byte-semantics, including the omitted parentId', () => {
    run('dump.mjs', [], { OUT_DIR: OUT });
    const a = loadDir(FIXTURE);
    const b = loadDir(OUT);
    expect([...b.nodes.keys()].sort()).toEqual([...a.nodes.keys()].sort());
    for (const [id, src] of a.nodes) {
      const dst = b.nodes.get(id)!;
      // Field-level identity on everything the canonical schema owns — brief
      // included: it round-trips through taxonomy_metadata, a separate table,
      // so node identity alone does not prove it survived.
      for (const k of ['id', 'level', 'kind', 'parentId', 'name', 'zone', 'ordinal', 'en', 'cs', 'brief'] as const) {
        expect(dst[k], `${id}.${k}`).toEqual(src[k]);
      }
    }
    // The root MUST NOT have grown a parentId in the dump.
    expect('parentId' in b.nodes.get('nos')!).toBe(false);
    // Relations round-trip through concept_relations — a third table.
    const key = (r: CanonRel) => `${r.from}|${r.to}|${r.type}`;
    expect(b.relations.map(key).sort()).toEqual(a.relations.map(key).sort());
    expect(a.relations.length).toBeGreaterThan(0); // guard the guard: non-empty
    // And the manifest names every slug domain.
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as {
      domains: Array<{ domain: string }>;
    };
    expect(manifest.domains.map((d) => d.domain).sort()).toEqual(['nos', 'nos.iiab', 'nos.infra']);
  });

  it('a removed domain FILE is swept when its root is part of the run', () => {
    // The ghost-subtree case: renaming/deleting nos.infra.json used to leave
    // its rows and marker behind — the subtree kept registering at boot, the
    // drift detector saw nothing (wrong key scope), and the next dump
    // resurrected the deleted file.
    const COPY = path.join(TMP, 'canon-copy');
    fs.cpSync(FIXTURE, COPY, { recursive: true });
    fs.rmSync(path.join(COPY, 'nos', 'nos.infra.json'));
    const out = run('ingest.mjs', ['--canonical', COPY, '--force']);
    const result = JSON.parse(out.slice(out.indexOf('INGEST_RESULT') + 'INGEST_RESULT '.length));
    expect(result.prunedDomains).toEqual(['nos.infra']);
    // The rows are genuinely gone, not just the marker.
    run('dump.mjs', [], { OUT_DIR: path.join(TMP, 'dump2') });
    const after = loadDir(path.join(TMP, 'dump2'));
    expect(after.nodes.has('nos.infra')).toBe(false);
    expect(after.nodes.has('nos.infra.redis')).toBe(false);
    expect(after.nodes.has('nos.iiab.nextcloud')).toBe(true); // untouched sibling domain
  });

  it('a second ingest of the dumped tree is a no-op re-apply (idempotent identity)', () => {
    const out = run('ingest.mjs', ['--canonical', OUT, '--force']);
    const result = JSON.parse(out.slice(out.indexOf('INGEST_RESULT') + 'INGEST_RESULT '.length));
    // Same ids, same names → the drift detector must stay silent.
    expect(result.reidentified).toEqual([]);
  });
});
