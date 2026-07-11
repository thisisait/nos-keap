/**
 * Knowledge objects — OKF-aligned index cards (ROADMAP.md Track S, S1).
 *
 * One row = one OKF concept document: `type` is the only required field
 * (open enum — note/page/query/table/database/file/lake/…), `resource` is a
 * URN/content-ref to where the real asset lives, `frontmatter` carries the
 * per-type structured payload (schema cards, SQL text, …), and the markdown
 * `body` is the summary the index searches over. The graph layer is emergent:
 * refs extracted from the body become untyped directed edges (OKF SPEC §5.3);
 * similarity is rendered as a view, never stored as an edge.
 */

export interface ObjectRef {
  /** 'node' (taxonomy id), 'object' (another card), 'service' (kiwix:… ref), 'url' */
  kind: 'node' | 'object' | 'service' | 'url';
  ref: string;
}

// Taxonomy ids look like "01", "01.02", "01.02.03.04" — dotted 2-digit runs.
const NODE_ID = /^\d{2}(?:\.\d{2})*$/;

function classifyRef(raw: string): ObjectRef | null {
  const ref = raw.trim();
  if (!ref) return null;
  if (NODE_ID.test(ref)) return { kind: 'node', ref };
  if (/^https?:\/\//i.test(ref)) return { kind: 'url', ref };
  if (ref.startsWith('object:')) return { kind: 'object', ref: ref.slice(7) };
  if (/^[a-z][a-z0-9_-]*:/.test(ref)) return { kind: 'service', ref };
  return null;
}

/**
 * Emergent graph edges: `[[ref]]` wiki links and `[text](ref)` markdown links
 * in the body, plus the card's own `resource`. Unknown shapes are dropped —
 * a dangling ref marks something worth writing later, not an error.
 */
export function extractRefs(body: string | undefined, resource: string | undefined): ObjectRef[] {
  const found = new Map<string, ObjectRef>();
  const add = (raw: string) => {
    const r = classifyRef(raw);
    if (r) found.set(`${r.kind}:${r.ref}`, r);
  };
  if (resource) add(resource);
  if (body) {
    for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) add(m[1]);
    for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) add(m[1]);
  }
  return [...found.values()];
}

/** Taxonomy anchors — the stars whose nebula this card joins. */
export function anchorNodeIds(refs: ObjectRef[]): string[] {
  return refs.filter((r) => r.kind === 'node').map((r) => r.ref);
}

/** Canonical embeddable text — mirrors nodeText/captureText in embeddings.ts. */
export function objectText(o: {
  type: string;
  title: string;
  description?: string;
  body?: string;
  tags?: string[];
}): string {
  return [o.type, o.title, o.description ?? '', (o.tags ?? []).join(' '), o.body ?? '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}
