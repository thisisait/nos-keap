import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A capture id names ONE user's capture. saveMetadataApi's upsert is keyed on
 * id alone, so before this guard any caller who knew (or guessed) another
 * user's capture id rewrote its title/url/metadata in place — reachable from
 * /api/metadata, /ingest/v1/capture (the extractable device-tier token) and
 * /agent/v1/captures. The guard lives in saveMetadataApi because every one of
 * those doors routes through it; same-owner re-sends stay idempotent.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keap-capown-'));
process.env.KEAP_DATA_DIR = TMP;

let db: typeof import('./db');

beforeAll(async () => {
  db = await import('./db');
  await db.initDb();
  db.saveMetadataApi('alice', { id: 'cap-1', title: 'Alice’s find', url: 'https://a.example' });
});

describe('capture ownership', () => {
  it('a different writer cannot overwrite an existing capture by id', () => {
    expect(() =>
      db.saveMetadataApi('device:evil', { id: 'cap-1', title: 'tampered' }),
    ).toThrow(/another user/);
    expect(db.getMetadataApi('cap-1')?.title).toBe('Alice’s find');
  });

  it('the owner re-sending the same id stays an idempotent update', () => {
    db.saveMetadataApi('alice', { id: 'cap-1', title: 'Alice’s find, retitled' });
    expect(db.getMetadataApi('cap-1')?.title).toBe('Alice’s find, retitled');
  });

  it('a fresh id inserts for anyone', () => {
    db.saveMetadataApi('device:kiosk', { id: 'cap-2', title: 'Kiosk capture' });
    expect(db.getMetadataApi('cap-2')?.title).toBe('Kiosk capture');
  });
});
