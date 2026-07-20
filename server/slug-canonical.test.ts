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
const loadDir = (dir: string): Map<string, CanonNode> => {
  const out = new Map<string, CanonNode>();
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (!f.endsWith('.json')) continue;
        const doc = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')) as { nodes: CanonNode[] };
        for (const n of doc.nodes) out.set(n.id, n);
      }
    }
  }
  return out;
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
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [id, src] of a) {
      const dst = b.get(id)!;
      // Field-level identity on everything the canonical schema owns.
      for (const k of ['id', 'level', 'kind', 'parentId', 'name', 'zone', 'ordinal', 'en', 'cs'] as const) {
        expect(dst[k], `${id}.${k}`).toEqual(src[k]);
      }
    }
    // The root MUST NOT have grown a parentId in the dump.
    expect('parentId' in b.get('nos')!).toBe(false);
  });

  it('a second ingest of the dumped tree is a no-op re-apply (idempotent identity)', () => {
    const out = run('ingest.mjs', ['--canonical', OUT, '--force']);
    const result = JSON.parse(out.slice(out.indexOf('INGEST_RESULT') + 'INGEST_RESULT '.length));
    // Same ids, same names → the drift detector must stay silent.
    expect(result.reidentified).toEqual([]);
  });
});
