import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The cooperative row lease (server/tables.ts claimRow/releaseRow) against a
 * real throwaway libSQL DB. Behavioural, not source-law: the lease is plain
 * relational SQL (no vector extension), so the unit env runs it for real, and
 * the one invariant that matters — "a second agent is blocked" — is a boolean
 * this suite actually observes.
 *
 * `now` is passed in, never read from the clock, so expiry/steal are
 * deterministic. KEAP_DATA_DIR is set BEFORE importing ./db (the data dir binds
 * at module load — the lesson row-refs.test.ts records).
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-claims-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');
let tables: typeof import('./tables');

const TABLE = 'roadmap';
const ROW = 'row-1';
const TTL = 900_000; // 15 min
const T0 = 1_000_000_000_000;

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  tables = await import('./tables');
});

describe('a row claim blocks a second agent', () => {
  it('the first claim wins; a second, different holder is refused', () => {
    const a = tables.claimRow(TABLE, ROW, 'agent:alice', T0, TTL);
    expect(a.ok).toBe(true);

    const b = tables.claimRow(TABLE, ROW, 'agent:bob', T0 + 1000, TTL);
    expect(b.ok, 'bob took a row alice holds — the lease does not block').toBe(false);
    expect(b.holder).toBe('agent:alice');
  });

  it('the holder may renew its own claim', () => {
    const again = tables.claimRow(TABLE, ROW, 'agent:alice', T0 + 2000, TTL);
    expect(again.ok).toBe(true);
    expect(again.expiresAt).toBe(T0 + 2000 + TTL);
  });

  it('an expired claim is stealable — a crashed holder self-heals', () => {
    const past = T0 + 2000 + TTL + 1; // one ms after alice's lease expires
    const b = tables.claimRow(TABLE, ROW, 'agent:bob', past, TTL);
    expect(b.ok, 'an expired lease was not stealable — a crash would wedge the row forever').toBe(true);
    expect(b.holder).toBe('agent:bob');
  });

  it('release frees the row only for its actual holder', () => {
    // alice does not hold it now (bob stole it), so her release is a no-op...
    expect(tables.releaseRow(TABLE, ROW, 'agent:alice')).toBe(false);
    // ...bob's release works, and then alice can take it.
    expect(tables.releaseRow(TABLE, ROW, 'agent:bob')).toBe(true);
    const a = tables.claimRow(TABLE, ROW, 'agent:alice', T0 + 5000, TTL);
    expect(a.ok).toBe(true);
  });
});
