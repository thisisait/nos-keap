import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * NEGATIVE lint coverage. Every case here is a tree that USED to lint green and
 * then failed somewhere later and quieter — dropped at boot, or bricking
 * re-ingest with a UNIQUE-constraint crash. A gate is only as good as the bad
 * inputs it has been shown to reject, so each rule gets a proven rejection, and
 * one green case guards against the rules over-firing.
 */
const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-lintneg-'));

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const EN = 'A description comfortably longer than the twenty-char floor.';

let n = 0;
const lint = (files: Record<string, unknown>): { code: number; out: string } => {
  const dir = path.join(TMP, `case-${n++}`, 'nos');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, doc] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, 1));
  }
  try {
    const out = execFileSync('node', [path.join(REPO, 'knowledge', 'lint.mjs'), '--canonical', path.dirname(dir)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

describe('knowledge lint — negative cases', () => {
  it('rejects a seed-override on a slug id (no seed node to overlay → subtree drops at boot)', () => {
    const r = lint({
      'nos.json': {
        domain: 'nos',
        nodes: [
          { id: 'nos', kind: 'seed-override', level: 0, en: EN },
        ],
        relations: [],
      },
      'nos.infra.json': {
        domain: 'nos.infra',
        nodes: [
          { id: 'nos.infra', kind: 'ext', level: 1, parentId: 'nos', name: 'infra', zone: 'free', ordinal: 0, en: EN },
        ],
        relations: [],
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('seed-override on a slug id');
    expect(r.out).toContain('subtree would drop at boot');
  });

  it('rejects a node outside its file\'s domain scope (re-ingest would crash on the id PK)', () => {
    const r = lint({
      'nos.json': {
        domain: 'nos',
        nodes: [
          { id: 'nos', kind: 'ext', level: 0, name: 'nOS', zone: 'free', ordinal: 0, en: EN },
          // Whole tree stuffed into the root file: the dotless wipe scope only
          // covers id='nos', so this row survives the wipe and the plain INSERT
          // dies on the PRIMARY KEY — ingest bricked for a lint-green layout.
          { id: 'nos.infra', kind: 'ext', level: 1, parentId: 'nos', name: 'infra', zone: 'free', ordinal: 0, en: EN },
        ],
        relations: [],
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("outside this file's domain scope");
  });

  it('rejects a malformed domain key (it is interpolated into the wipe-scope SQL)', () => {
    const r = lint({
      'evil.json': {
        domain: "nos' OR '1'='1",
        nodes: [{ id: 'nos', kind: 'ext', level: 0, name: 'nOS', zone: 'free', ordinal: 0, en: EN }],
        relations: [],
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('malformed domain key');
  });

  it('still accepts the real selfmodel fixture (the rules must not over-fire)', () => {
    const out = execFileSync(
      'node',
      [path.join(REPO, 'knowledge', 'lint.mjs'), '--canonical', path.join(REPO, 'e2e', 'fixtures', 'selfmodel')],
      { encoding: 'utf8' },
    );
    expect(out).toContain('lint clean');
  });
});
