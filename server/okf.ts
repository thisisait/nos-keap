/**
 * OKF bundle export/import (ROADMAP S3) — knowledge objects as an Open
 * Knowledge Format directory: `objects/<type>/<slug>-<id8>.md` with YAML
 * frontmatter, zipped.
 *
 * Conformance (github.com/GoogleCloudPlatform/knowledge-catalog/okf, v0.1):
 * the ONLY required field is `type`; `title`, `description`, `resource`,
 * `tags`, `timestamp` are the standard optional fields — the mapping to
 * knowledge_objects is 1:1. Everything KEAP-specific (id, content hash,
 * intake source/modality/capturedAt, promotion provenance) nests under a
 * single `keap:` extension key so any OKF consumer (openknowledge CLI)
 * reads the bundle without knowing us.
 *
 * Import NEVER writes the curated layer directly: every card lands in the
 * intake review queue (source app:okf-import) with an auto-generated
 * promotion proposal carrying the ORIGINAL object id — the moderator's
 * approval materializes an identical card (that is what makes the
 * export → import → approve roundtrip identity-preserving). Dedupe: a card
 * whose id already exists with the same content hash is skipped.
 */
import crypto from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import YAML from 'yaml';
import * as db from './db';
import { normalizeAndSaveCapture } from './intake';
import { propose } from './promotions';

/** Canonical content hash — the dedupe key next to id. */
export function objectContentHash(o: {
  type: string;
  title: string;
  description?: string;
  body?: string;
  resource?: string;
  tags?: string[];
}): string {
  const canon = JSON.stringify([
    o.type, o.title, o.description ?? '', o.body ?? '', o.resource ?? '', [...(o.tags ?? [])].sort(),
  ]);
  return crypto.createHash('sha1').update(canon).digest('hex');
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportBundle(userId: string, seeAll: boolean): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const objects = db.getObjects(userId, seeAll);
  for (const o of objects) {
    const fm: Record<string, unknown> = { type: o.type };
    if (o.title) fm.title = o.title;
    if (o.description) fm.description = o.description;
    if (o.resource) fm.resource = o.resource;
    if (o.tags?.length) fm.tags = o.tags;
    fm.timestamp = new Date(o.updatedAt * 1000).toISOString();
    const keap: Record<string, unknown> = {
      id: o.id,
      content_hash: objectContentHash(o),
    };
    const f = o.frontmatter ?? {};
    for (const k of ['promotedFrom', 'proposedBy', 'approvedBy', 'source', 'modality', 'capturedAt']) {
      if (f[k] !== undefined) keap[k] = f[k];
    }
    fm.keap = keap;
    const md = `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n${o.body ?? ''}\n`;
    const safeType = slugify(o.type) || 'note';
    files[`objects/${safeType}/${slugify(o.title)}-${o.id.slice(0, 8)}.md`] = strToU8(md);
  }
  files['README.md'] = strToU8(
    '# KEAP knowledge bundle (Open Knowledge Format)\n\n' +
      `Exported ${objects.length} knowledge object(s) from the nOS cortex.\n` +
      'Layout: objects/<type>/<slug>-<id8>.md — YAML frontmatter per OKF v0.1 ' +
      '(only required key: `type`); KEAP provenance nests under `keap:`.\n',
  );
  return zipSync(files, { level: 6 });
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportReport {
  files: number;
  queued: number;
  skippedIdentical: number;
  errors: Array<{ file: string; error: string }>;
}

export function importBundle(zip: Uint8Array, importedBy: string): ImportReport {
  const report: ImportReport = { files: 0, queued: 0, skippedIdentical: 0, errors: [] };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new Error('not a readable zip archive');
  }
  for (const [name, raw] of Object.entries(entries)) {
    if (!name.endsWith('.md') || name === 'README.md' || name.endsWith('/README.md')) continue;
    report.files++;
    try {
      const text = strFromU8(raw);
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      if (!m) throw new Error('missing YAML frontmatter');
      const fm = YAML.parse(m[1]) ?? {};
      if (!fm.type) throw new Error('OKF requires `type`');
      const body = m[2].trim();
      const draft = {
        id: typeof fm.keap?.id === 'string' ? fm.keap.id : undefined,
        type: String(fm.type),
        title: String(fm.title ?? name.split('/').pop()!.replace(/\.md$/, '')),
        description: fm.description ? String(fm.description) : undefined,
        body: body || undefined,
        resource: fm.resource ? String(fm.resource) : undefined,
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
      };
      // Dedupe: same id + same content -> nothing to do.
      if (draft.id) {
        const existing = db.getObject(draft.id);
        if (existing && objectContentHash(existing) === objectContentHash(draft)) {
          report.skippedIdentical++;
          continue;
        }
      }
      // Through the intake review queue — never straight into the corpus.
      const captureId = `okf-${crypto.createHash('sha1').update(name + (draft.id ?? '')).digest('hex').slice(0, 24)}`;
      normalizeAndSaveCapture(
        {
          id: captureId,
          source: { kind: 'app', name: 'okf-import' },
          modality: 'text',
          title: draft.title,
          text: draft.description ?? body.slice(0, 2000) ?? draft.title,
          tags: draft.tags,
          metadata: { okfFile: name, importedBy },
        },
        `app:okf-import`,
      );
      // Auto-proposal so the moderator one-clicks; the ORIGINAL id rides the
      // draft, keeping the roundtrip identity-preserving.
      propose(captureId, draft, `OKF import (${name}) by ${importedBy}`, `app:okf-import`);
      report.queued++;
    } catch (err) {
      report.errors.push({ file: name, error: (err as Error).message });
    }
  }
  return report;
}
