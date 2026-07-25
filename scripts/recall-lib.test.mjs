/**
 * The recall gate's decision layer, tested against the FIVE defects it shipped
 * with (2026-07-25). Each block below is written from the concrete scenario
 * that made the defect visible, so a regression reads as the original bug
 * rather than as an abstract assertion failure.
 *
 * `.mjs`, not `.ts`: the knowledge CI job installs with --ignore-scripts and no
 * .ts file in this repo can be transformed there (see vitest.config.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  SEMANTICS,
  baselineWriteVerdict,
  classifyAgainstBaseline,
  embedCorpus,
  exitVerdict,
  gradeCase,
  measuredFloor,
  properAncestors,
} from './recall-lib.mjs';

const node = (id) => ({ kind: 'taxonomy', refId: id });
const card = (id) => ({ kind: 'object', refId: id });
const res = (resolved, counts = {}) => ({
  resolved,
  nodeRefs: resolved.filter((r) => r.kind === 'taxonomy').length,
  nodeHits: resolved.filter((r) => r.kind === 'taxonomy').length,
  titleRefs: resolved.filter((r) => r.kind === 'object').length,
  titleHits: resolved.filter((r) => r.kind === 'object').length,
  ambiguous: 0,
  ...counts,
});
const hit = (kind, refId, legs = ['lexical']) => ({ kind, refId, legs });

// ── DEFECT 1 ────────────────────────────────────────────────────────────────
// The ancestor exemption silently voided the forbid half of all 261 cases.
describe('defect 1 — an explicitly forbidden ancestor is still compared', () => {
  // The literal motivating scenario, transcribed from the nOS set:
  //   {"q":"upload file","expect":["node:nos.iiab.nextcloud","title:upload-file"],
  //    "forbid":["node:nos","node:nos.iiab"]}
  // with the stack node ranked #1 and the root #2, both ABOVE the skill card.
  // Under the shipped code this printed `✓ "upload file" → rank 1`.
  const scenario = {
    hits: [
      hit('taxonomy', 'nos.iiab'),
      hit('taxonomy', 'nos'),
      hit('object', 'fs:nos-docs:upload-file'),
    ],
    expect: res([node('nos.iiab.nextcloud'), card('fs:nos-docs:upload-file')]),
    forbid: res([node('nos'), node('nos.iiab')]),
    anchorsById: new Map([['fs:nos-docs:upload-file', ['nos.iiab.nextcloud']]]),
    scopeRoot: 'nos',
    k: 5,
  };

  it('FAILS the case when the forbidden stack and root outrank the target', () => {
    const g = gradeCase(scenario);
    expect(g.inTop).toBe(true); // presence half still passes — that was never the bug
    expect(g.cleanRank).toBe(false);
    expect(g.ok).toBe(false);
    expect(g.blockedBy).toBe('taxonomy:nos.iiab');
    expect(g.bestForbidden).toBe(1);
    expect(g.bestExpected).toBe(3);
  });

  it('reports the forbid refs as COMPARED, so a dead forbid half is visible', () => {
    const g = gradeCase(scenario);
    expect(g.forbidNamed).toBe(2);
    expect(g.forbidResolved).toBe(2);
    // The number that read 0/522 for the whole live set while it reported 261/261.
    expect(g.forbidComparable).toBe(2);
    expect(g.degraded).not.toContain('degraded:presence-only');
  });

  it('still passes the case when the target outranks the forbidden ancestors', () => {
    const g = gradeCase({
      ...scenario,
      hits: [
        hit('object', 'fs:nos-docs:upload-file'),
        hit('taxonomy', 'nos.iiab'),
        hit('taxonomy', 'nos'),
      ],
    });
    expect(g.ok).toBe(true);
    expect(g.bestExpected).toBe(1);
    expect(g.bestForbidden).toBe(2);
  });

  it('keeps exempting ancestors that the case does NOT forbid', () => {
    // Navigation stays navigation: an unforbidden parent beside its own child is
    // the search working as designed, and must not fail the case.
    const g = gradeCase({
      ...scenario,
      forbid: res([]),
    });
    expect(g.excluded).toEqual(['taxonomy:nos.iiab', 'taxonomy:nos']);
    expect(g.ok).toBe(true);
    expect(g.bestExpected).toBe(1);
  });

  it('properAncestors() protects forbidden ids but nothing else', () => {
    const anc = properAncestors([node('nos.iiab.nextcloud')], {
      scopeRoot: 'nos',
      protect: [node('nos.iiab')],
    });
    expect(anc.has('nos.iiab')).toBe(false); // forbidden → competes
    expect(anc.has('nos')).toBe(true); // merely an ancestor → exempt
  });
});

// ── DEFECT 4 ────────────────────────────────────────────────────────────────
// Unresolvable forbid refs vanished; the case still reported a full PASS.
describe('defect 4 — a forbid ref that resolves to nothing is reported', () => {
  it('flags PRESENCE ONLY when no forbid ref could be compared', () => {
    // nOS adds `forbid: ["node:nos.iiab.outline"]` — a system the 3-system
    // in-repo fixture does not contain. The relative-order assertion cannot run.
    const g = gradeCase({
      hits: [hit('object', 'fs:nos-docs:create-document')],
      expect: res([card('fs:nos-docs:create-document')]),
      forbid: { resolved: [], nodeRefs: 1, nodeHits: 0, titleRefs: 0, titleHits: 0, ambiguous: 0 },
      scopeRoot: 'nos',
      k: 5,
    });
    expect(g.ok).toBe(true); // it is not a failure …
    expect(g.degraded).toContain('degraded:presence-only'); // … but it is not a full pass either
    expect(g.forbidNamed).toBe(1);
    expect(g.forbidResolved).toBe(0);
    expect(g.forbidComparable).toBe(0);
  });

  it('flags a PARTIAL relative order when only some forbid refs resolve', () => {
    const g = gradeCase({
      hits: [hit('object', 'fs:nos-docs:create-document')],
      expect: res([card('fs:nos-docs:create-document')]),
      forbid: { resolved: [node('nos.iiab')], nodeRefs: 2, nodeHits: 1, titleRefs: 0, titleHits: 0, ambiguous: 0 },
      scopeRoot: 'nos',
      k: 5,
    });
    expect(g.degraded).toContain('degraded:forbid-partial');
    expect(g.degraded).not.toContain('degraded:presence-only');
    expect(g.forbidComparable).toBe(1);
  });

  it('says nothing when a case names no forbid refs at all', () => {
    const g = gradeCase({
      hits: [hit('object', 'c1')],
      expect: res([card('c1')]),
      forbid: res([]),
      scopeRoot: 'nos',
      k: 5,
    });
    expect(g.degraded).toEqual([]);
    expect(g.forbidNamed).toBe(0);
  });
});

// ── DEFECT 2 ────────────────────────────────────────────────────────────────
// The embed loop stopped at 12 rounds with no drain assertion.
describe('defect 2 — the embed loop asserts that pending actually drained', () => {
  /** A fake corpus of `size` items, paged at 500 exactly like the server. */
  const fakeCorpus = (size, { maxRounds }) => {
    let done = 0;
    const posted = [];
    return {
      posted,
      run: () =>
        embedCorpus({
          maxRounds,
          fetchPending: async () => ({
            dim: 768,
            total: size - done,
            items: Array.from({ length: Math.min(500, size - done) }, (_, i) => ({
              kind: 'object', refId: `r${done + i}`, contentHash: 'h', text: 't',
            })),
          }),
          embedBatch: async (batch) => batch.map((b) => ({ ...b, vector: [0] })),
          postVectors: async (items) => { posted.push(...items); done += items.length; },
        }),
    };
  };

  it('does NOT claim success on a corpus larger than the round ceiling', async () => {
    // 6500 embeddable items — the 790-node seed spine plus nOS's tree and cards,
    // which is exactly what "ship a larger canonical fixture" produces — against
    // the shipped ceiling of 12 rounds × 500.
    const c = fakeCorpus(6500, { maxRounds: 12 });
    const drain = await c.run();
    expect(drain.embedded).toBe(6000);
    expect(drain.drained).toBe(false);
    expect(drain.reason).toBe('round-ceiling');
    expect(drain.remaining).toBe(500);
  });

  it('an undrained corpus is a loud skip, never a pass, even with zero failures', () => {
    const drain = { drained: false, remaining: 500, rounds: 12, reason: 'round-ceiling' };
    const v = exitVerdict({ measured: 261, total: 261, failures: [], need: 261, coverageLost: [], drain });
    expect(v.code).toBe(4);
    expect(v.reason).toBe('not-drained');
  });

  it('drains a corpus that fits and reports it', async () => {
    const c = fakeCorpus(1200, { maxRounds: 200 });
    const drain = await c.run();
    expect(drain.embedded).toBe(1200);
    expect(drain.drained).toBe(true);
    expect(drain.remaining).toBe(0);
    expect(drain.rounds).toBe(3);
  });

  it('stops with no-progress rather than burning rounds when the write-back is not landing', async () => {
    const drain = await embedCorpus({
      maxRounds: 200,
      fetchPending: async () => ({
        dim: 768,
        total: 900,
        items: Array.from({ length: 500 }, (_, i) => ({ kind: 'object', refId: `r${i}`, contentHash: 'h', text: 't' })),
      }),
      embedBatch: async (batch) => batch.map((b) => ({ ...b, vector: [0] })),
      postVectors: async () => {}, // the vectors go nowhere
    });
    expect(drain.drained).toBe(false);
    expect(drain.reason).toBe('no-progress');
    expect(drain.rounds).toBe(1);
  });
});

// ── DEFECT 3 ────────────────────────────────────────────────────────────────
// --update-baseline wrote before the guards, so a degraded run erased coverage.
describe('defect 3 — a degraded run may not overwrite the baseline', () => {
  // The concrete scenario: the operator records the live baseline while the
  // pulse job is still embedding, and only 140 of 261 cases resolve.
  const degradedRun = { measured: 140, total: 261, need: measuredFloor('50%', 261), coverageLost: Array.from({ length: 121 }, (_, i) => `q${i}`) };

  it('refuses the write when coverage the baseline holds is gone', () => {
    const w = baselineWriteVerdict(degradedRun);
    expect(w.allow).toBe(false);
    expect(w.blockers.join(' ')).toMatch(/121 case\(s\)/);
  });

  it('refuses the write when the corpus never finished embedding', () => {
    const w = baselineWriteVerdict({
      measured: 261, total: 261, need: 131, coverageLost: [],
      drain: { drained: false, remaining: 500, reason: 'round-ceiling' },
    });
    expect(w.allow).toBe(false);
  });

  it('refuses the write below the declared floor, and when nothing was measured', () => {
    expect(baselineWriteVerdict({ measured: 100, total: 261, need: 131, coverageLost: [] }).allow).toBe(false);
    expect(baselineWriteVerdict({ measured: 0, total: 261, need: 0, coverageLost: [] }).allow).toBe(false);
  });

  it('allows the write on a healthy run, including one with plain failures to record', () => {
    expect(baselineWriteVerdict({ measured: 261, total: 261, need: 131, coverageLost: [] }).allow).toBe(true);
  });

  it('refuses to shrink the file on disk even when the comparison was skipped', () => {
    // The hole the semantics bump would otherwise open: a refused baseline
    // yields NO coverageLost, so without the file's own denominator a 140-case
    // run could quietly replace a 261-case record and clear every later guard.
    const w = baselineWriteVerdict({ measured: 140, total: 261, need: 131, coverageLost: [], priorMeasured: 261 });
    expect(w.allow).toBe(false);
    expect(w.blockers.join(' ')).toMatch(/erase 121 case\(s\)/);
    // Same denominator, new semantics, is a normal re-record and must go through.
    expect(baselineWriteVerdict({ measured: 261, total: 261, need: 131, coverageLost: [], priorMeasured: 261 }).allow).toBe(true);
  });

  it('--force-baseline is the ONLY way past a blocker, and says it was forced', () => {
    const w = baselineWriteVerdict({ ...degradedRun, force: true });
    expect(w.allow).toBe(true);
    expect(w.forced).toBe(true);
    expect(w.blockers.length).toBe(1);
  });

  it('the run that erased coverage is itself a loud skip — write and exit agree', () => {
    // Both halves of the original defect in one assertion: the run exits 4 AND
    // the file is left alone. Before the fix the file was already overwritten by
    // the time this verdict was reached.
    const v = exitVerdict({ ...degradedRun, failures: [] });
    expect(v.code).toBe(4);
    expect(baselineWriteVerdict(degradedRun).allow).toBe(false);
  });
});

// ── DEFECT 5 ────────────────────────────────────────────────────────────────
// "NEW & FAILING" mislabelled cases the baseline recorded as unmeasurable, and
// double-counted them under NEW COVERAGE.
describe('defect 5 — a newly covered case that fails is neither new nor a regression', () => {
  const baseline = {
    passing: ['upload a file'],
    failing: ['list databases'],
    unmeasurable: { 'create a document in outline': 'gap:node-absent' },
  };
  const c = classifyAgainstBaseline({
    passing: ['list databases'],
    failing: ['create a document in outline', 'upload a file', 'a query nobody has seen'],
    unmeasurable: [],
    baseline,
  });

  it('classifies it as NEWLY COVERED & FAILING, not as a new expectation', () => {
    expect(c.newlyCoveredFailing).toEqual(['create a document in outline']);
    expect(c.newlyFailing).toEqual(['a query nobody has seen']);
  });

  it('puts every failing case in exactly one bucket', () => {
    const buckets = [...c.regressions, ...c.knownFailing, ...c.newlyCoveredFailing, ...c.newlyFailing];
    expect(buckets.length).toBe(3);
    expect(new Set(buckets).size).toBe(3);
    expect(c.regressions).toEqual(['upload a file']);
    expect(c.knownFailing).toEqual([]);
  });

  it('splits NEW COVERAGE so nothing is counted as passing and failing at once', () => {
    expect(c.newCoveragePassing).toEqual([]);
    expect(c.newCoverageFailing).toEqual(['create a document in outline']);
  });

  it('still reports coverage lost and fixed cases', () => {
    const c2 = classifyAgainstBaseline({
      passing: ['list databases'],
      failing: [],
      unmeasurable: ['upload a file'],
      baseline,
    });
    expect(c2.coverageLost).toEqual(['upload a file']);
    expect(c2.fixed).toEqual(['list databases']);
  });
});

describe('exit verdict order and the measured floor', () => {
  it('checks the drain before anything else, then measurability, then failures', () => {
    const base = { measured: 261, total: 261, need: 131, coverageLost: [] };
    expect(exitVerdict({ ...base, failures: ['x'], drain: { drained: false, remaining: 1, rounds: 12, reason: 'round-ceiling' } }).reason).toBe('not-drained');
    expect(exitVerdict({ ...base, measured: 0, failures: [] }).reason).toBe('nothing-measured');
    expect(exitVerdict({ ...base, failures: ['x'] }).code).toBe(1); // no baseline ⇒ strict
    expect(exitVerdict({ ...base, measured: 100, failures: [] }).reason).toBe('below-floor');
    expect(exitVerdict({ ...base, failures: [], coverageLost: ['x'] }).reason).toBe('coverage-lost');
    expect(exitVerdict({ ...base, failures: [] }).code).toBe(0);
  });

  it('reads the declared floor in both cases and both opt-outs', () => {
    expect(measuredFloor('50%', 261)).toBe(131);
    expect(measuredFloor('100%', 261)).toBe(261);
    expect(measuredFloor('261', 261)).toBe(261);
    expect(measuredFloor('0', 261)).toBe(0);
    expect(measuredFloor('none', 261)).toBe(0);
  });

  it('declares a semantics generation, so old baselines can be refused', () => {
    expect(SEMANTICS).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The sixth defect, found by running the gate rather than reading it: the
 * baseline comparison computed REGRESSIONS, printed them, and then threw the
 * answer away. `exitVerdict` failed on `failures.length`, so a run reporting
 * "0 regressions, 2 known failing" still exited 1.
 *
 * That is not a cosmetic bug. The in-repo fixture holds 7 nodes across one
 * stack-pair, and two of its four cases forbid an ancestor from outranking a
 * skill — which a corpus that small cannot satisfy no matter how good recall
 * is. So `npm run gate:recall` was permanently red, and a gate that can never
 * go green is one people learn to ignore.
 */
describe('exit verdict distinguishes a regression from a known failure', () => {
  const base = { measured: 4, total: 4, drain: { drained: true } };

  it('fails on a regression — passed in the baseline, fails now', () => {
    const v = exitVerdict({ ...base, failures: ['q'], hasBaseline: true, regressions: ['q'] });
    expect(v.code).toBe(1);
    expect(v.reason).toBe('regressions');
  });

  it('passes when the only failures are ones the baseline already recorded', () => {
    const v = exitVerdict({ ...base, failures: ['q'], hasBaseline: true, knownFailing: ['q'] });
    expect(v.code).toBe(0);
    expect(v.reason).toBe('pass-with-known-failures');
    // green, but never silently — the reason itself carries the debt
    expect(v.detail).toContain('1 known failing');
  });

  it('does not punish widening coverage: a newly measured failure is news, not a regression', () => {
    const v = exitVerdict({ ...base, failures: ['q'], hasBaseline: true, newlyCoveredFailing: ['q'] });
    expect(v.code).toBe(0);
    expect(v.detail).toContain('newly covered');
  });

  it('does not punish adding a case to the query set either', () => {
    const v = exitVerdict({ ...base, failures: ['q'], hasBaseline: true, newlyFailing: ['q'] });
    expect(v.code).toBe(0);
    expect(v.detail).toContain('new case');
  });

  it('stays strict with NO baseline — a failure cannot be called known on a corpus never recorded', () => {
    const v = exitVerdict({ ...base, failures: ['q'], hasBaseline: false });
    expect(v.code).toBe(1);
    expect(v.reason).toBe('failures');
  });

  it('a regression still fails even when known failures are present alongside it', () => {
    const v = exitVerdict({ ...base, failures: ['a', 'b'], hasBaseline: true, regressions: ['a'], knownFailing: ['b'] });
    expect(v.code).toBe(1);
    expect(v.reason).toBe('regressions');
  });

  it('a clean run is still a plain pass, not a pass-with-debt', () => {
    expect(exitVerdict({ ...base, failures: [] }).reason).toBe('pass');
  });

  it('drain and nothing-measured still outrank the baseline comparison', () => {
    expect(exitVerdict({ ...base, failures: ['q'], hasBaseline: true, knownFailing: ['q'], drain: { drained: false, remaining: 3, rounds: 12, reason: 'round-ceiling' } }).code).toBe(4);
    expect(exitVerdict({ ...base, measured: 0, failures: [], hasBaseline: true }).code).toBe(4);
  });
});
