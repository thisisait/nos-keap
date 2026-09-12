import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * decideBriefBulk — the apply half of the weekly moderation-drain loop.
 * The interesting properties are SELECTION (only the listed ids, only kind
 * 'brief') and IDEMPOTENCE (a re-run reports already-decided ids as errors
 * instead of failing the batch) — the two things the nOS-side loop builds on.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-briefbulk-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let promotions: typeof import('./promotions');

const BRIEF = [
  'A brief long enough to clear the 300-character validation floor. It talks about the node in several honest sentences, links its neighbourhood, and generally behaves like the librarian output it stands in for during this test run of the bulk decide path.',
  'Second paragraph, because briefs are articles, not captions. See also [[01.01]] for the anchor this test leans on.',
].join('\n\n');

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  promotions = await import('./promotions');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('decideBriefBulk', () => {
  it('decides exactly the listed ids, skips non-brief kinds, and re-runs safely', () => {
    const a = promotions.proposeBrief({ nodeId: '01.01', briefEn: BRIEF }, undefined, 'agent:librarian');
    const b = promotions.proposeBrief({ nodeId: '01.02', briefEn: BRIEF }, undefined, 'agent:librarian');
    const c = promotions.proposeBrief({ nodeId: '01.03', briefEn: BRIEF }, undefined, 'agent:librarian');
    const desc = promotions.proposeDescription(
      { nodeId: '01.04', descriptionEn: 'A perfectly reasonable description override.' },
      undefined,
      'agent:librarian',
    );

    // Selection: only a+b (and the desc, which must be refused by kind).
    const r1 = promotions.decideBriefBulk([a.id, b.id, desc.id, 'no-such-id'], 'approve', 'operator');
    expect(r1.decided).toBe(2);
    expect(r1.errors.map((e) => e.id).sort()).toEqual([desc.id, 'no-such-id'].sort());
    expect(r1.errors.find((e) => e.id === desc.id)?.error).toMatch(/not a brief/);

    // The approve materialized: the curated note layer carries the brief.
    const row = db.getTaxonomyMetadata('01.01');
    expect(!Array.isArray(row) && row?.data?.brief).toBe(BRIEF);
    // ...and the unlisted id c stays untouched.
    expect(db.getPromotion(c.id)?.status).toBe('proposed');

    // Idempotence: the same batch again decides nothing and fails nothing.
    const r2 = promotions.decideBriefBulk([a.id, b.id], 'approve', 'operator');
    expect(r2.decided).toBe(0);
    expect(r2.errors.map((e) => e.error)).toEqual([
      'promotion already approved',
      'promotion already approved',
    ]);

    // Reject leg works through the same path.
    const r3 = promotions.decideBriefBulk([c.id], 'reject', 'operator');
    expect(r3.decided).toBe(1);
    expect(db.getPromotion(c.id)?.status).toBe('rejected');
  });
});
