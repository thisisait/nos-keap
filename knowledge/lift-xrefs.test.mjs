import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

/**
 * Guards the v1.47 04.11 loss: 19 curated typed relations carried
 * source='brief-xref', which lift-xrefs unconditionally drops and re-derives
 * (as type 'references') from the current briefs — so every curated typing
 * under that source was silently deleted by the re-lift in e6fe9cd.
 *
 * Contract pinned here: source='curated-xref' rows survive a lift-xrefs run
 * byte-identically, and lint refuses the doomed shape (a non-'references'
 * type under source='brief-xref').
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIFT = path.join(HERE, 'lift-xrefs.mjs');
const LINT = path.join(HERE, 'lint.mjs');

let TMP;
const DOC = path.join('99-test', '99.01.json');

const node = (id, extra = {}) => ({
  id, level: id.split('.').length - 1, parentId: id.split('.').slice(0, -1).join('.') || undefined,
  name: `Node ${id}`, zone: 'votable', ordinal: 0, kind: 'ext',
  en: `English description for ${id}, long enough for the linter gate.`,
  ...extra,
});

function writeDoc(relations) {
  const doc = {
    domain: '99.01',
    nodes: [
      node('99.01', { level: 1, parentId: '99', brief: 'See also [[99.01.02]].' }),
      node('99.01.01'),
      node('99.01.02'),
    ],
    relations,
  };
  writeFileSync(path.join(TMP, DOC), JSON.stringify(doc, null, 1) + '\n');
}

beforeAll(() => {
  TMP = path.join(os.tmpdir(), `lift-xrefs-test-${process.pid}`);
  mkdirSync(path.join(TMP, '99-test'), { recursive: true });
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('lift-xrefs curated-relation preservation', () => {
  it('keeps source=curated-xref rows across a re-lift and re-derives brief xrefs', () => {
    const curated = { from: '99.01.01', to: '99.01.02', type: 'specializes', explored: null, source: 'curated-xref' };
    writeDoc([curated]);
    execFileSync('node', [LIFT, '--canonical', TMP]);
    const rels = JSON.parse(readFileSync(path.join(TMP, DOC), 'utf8')).relations;
    expect(rels).toContainEqual(curated);
    expect(rels).toContainEqual({ from: '99.01', to: '99.01.02', type: 'references', explored: null, source: 'brief-xref' });
  });

  it('lint rejects a curated typing filed under source=brief-xref (lift-xrefs would delete it)', () => {
    writeDoc([{ from: '99.01.01', to: '99.01.02', type: 'specializes', explored: null, source: 'brief-xref' }]);
    let out = '';
    try { execFileSync('node', [LINT, '--canonical', TMP]); }
    catch (e) { out = String(e.stdout) + String(e.stderr); }
    expect(out).toContain("lift-xrefs will delete it");
  });
});
