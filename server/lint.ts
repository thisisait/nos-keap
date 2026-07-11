/**
 * Knowledge lint — the cortex's periodic health check (Karpathy's third
 * operation, extended for a vector-native corpus).
 *
 * Karpathy's LLM-wiki lint covers contradictions, stale claims, orphan pages
 * and missing cross-references over markdown. KEAP's corpus is richer — a
 * typed graph (taxonomy / captures / notes / objects) with embeddings IN the
 * tables — so the lint is two-layered:
 *
 *   Layer 1 (this file, deterministic, no LLM):
 *     referential integrity  broken [[anchors]], notes on unknown nodes,
 *                            unresolvable content refs
 *     hygiene                orphan objects, stale review-queue captures
 *     substrate integrity    FTS drift, layout drift, embedding backlog
 *     vector analysis        near-duplicates (merge candidates), overlap
 *                            pairs (contradiction CANDIDATES), taxonomy twins
 *     coverage               knowledge deserts (branches with zero content)
 *
 *   Layer 2 (future, agentic): the `overlap-review` findings are the intake
 *     queue for the librarian agent — an LLM judge that reads both texts and
 *     decides duplicate / contradiction / fine. Layer 1 only ever flags
 *     CANDIDATES; it never claims two texts disagree.
 *
 * Findings have a stable id = sha1(check + sorted refs) and live in
 * lint_findings with a first_seen/last_seen/resolved_at lifecycle
 * (db.syncLintFindings). The host-side Pulse job (nOS keap-lint) notifies
 * only on NEW findings — a standing finding never re-alerts.
 */
import crypto from 'node:crypto';
import * as db from './db';
import { allNodes, getNode, type FlatNode } from './taxonomy';
import { resolveContentRef } from './content-links';
import { anchorNodeIds, type ObjectRef } from './objects';
import { pendingEmbeddings } from './embeddings';

export type LintSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface LintFinding {
  id: string;
  checkId: string;
  severity: LintSeverity;
  refKind?: string;
  refId?: string;
  message: string;
  data?: any;
}

export interface LintReport {
  ranChecks: string[];
  counts: Record<LintSeverity, number>;
  open: number;
  new: number;
  resolved: number;
  newBySeverity: Record<string, number>;
  findings: db.LintFindingRow[];
}

// Cosine-distance bands for the vector checks. Calibrated on the live
// nomic-embed-text corpus (sibling taxonomy nodes sit ~0.10-0.25 apart;
// "File Formats" vs "Archive Formats" ≈ 0.08).
const DUP_DISTANCE = 0.04; // near-certain duplicate content
const OVERLAP_DISTANCE = 0.12; // same-topic pair worth an LLM/human look
const TWIN_DISTANCE = 0.03; // taxonomy nodes with near-identical wording
const STALE_CAPTURE_S = 90 * 24 * 3600;
const PAIR_LIMIT = 40; // per vector check, keep reports bounded

function fid(checkId: string, ...refs: string[]): string {
  return crypto.createHash('sha1').update(`${checkId}:${refs.sort().join('|')}`).digest('hex').slice(0, 20);
}

function label(kind: string, refId: string): string {
  if (kind === 'taxonomy') return getNode(refId)?.name ?? refId;
  if (kind === 'object') return db.getObject(refId)?.title ?? refId;
  if (kind === 'capture') {
    return db.getAllMetadataApi('', true).find((c) => c.id === refId)?.title ?? refId;
  }
  return refId;
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkNoteAnchors(out: LintFinding[]): void {
  const notes = db.getTaxonomyMetadata();
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!getNode(note.id)) {
      out.push({
        id: fid('note-on-unknown-node', note.id),
        checkId: 'note-on-unknown-node',
        severity: 'high',
        refKind: 'note',
        refId: note.id,
        message: `Curated note is keyed to taxonomy node "${note.id}" which does not exist (tree changed?)`,
      });
    }
  }
}

function checkObjectAnchors(out: LintFinding[]): void {
  for (const o of db.getObjects('', true)) {
    const anchors = anchorNodeIds((o.links ?? []) as ObjectRef[]);
    const broken = anchors.filter((a) => !getNode(a));
    for (const a of broken) {
      out.push({
        id: fid('broken-anchor', o.id, a),
        checkId: 'broken-anchor',
        severity: 'high',
        refKind: 'object',
        refId: o.id,
        message: `Object "${o.title}" anchors to unknown taxonomy node [[${a}]]`,
        data: { anchor: a },
      });
    }
    if (anchors.length === 0) {
      out.push({
        id: fid('orphan-object', o.id),
        checkId: 'orphan-object',
        severity: 'info',
        refKind: 'object',
        refId: o.id,
        message: `Object "${o.title}" has no [[taxonomy]] anchor — invisible in the universe (panel/search only)`,
      });
    }
    if (o.resource && !resolveContentRef(o.resource)) {
      out.push({
        id: fid('broken-content-ref', 'object', o.id),
        checkId: 'broken-content-ref',
        severity: 'medium',
        refKind: 'object',
        refId: o.id,
        message: `Object "${o.title}" resource ref "${o.resource}" does not resolve (unknown/disabled service)`,
        data: { ref: o.resource },
      });
    }
  }
}

function checkCuratedContentRefs(out: LintFinding[]): void {
  const notes = db.getTaxonomyMetadata();
  for (const note of Array.isArray(notes) ? notes : []) {
    const ref = note.data?.requiredData;
    if (ref && !resolveContentRef(ref)) {
      out.push({
        id: fid('broken-content-ref', 'note', note.id),
        checkId: 'broken-content-ref',
        severity: 'medium',
        refKind: 'note',
        refId: note.id,
        message: `Curated content ref "${ref}" on node "${label('taxonomy', note.id)}" does not resolve`,
        data: { ref },
      });
    }
  }
}

function checkStaleCaptures(out: LintFinding[]): void {
  const now = Math.floor(Date.now() / 1000);
  for (const c of db.getAllMetadataApi('', true)) {
    if (now - c.updatedAt > STALE_CAPTURE_S) {
      out.push({
        id: fid('stale-capture', c.id),
        checkId: 'stale-capture',
        severity: 'low',
        refKind: 'capture',
        refId: c.id,
        message: `Capture "${c.title}" has sat in the review queue for >90 days — promote to an object or drop it`,
      });
    }
  }
}

function checkSubstrate(out: LintFinding[]): void {
  const nodeCount = allNodes().length;
  const fts = db.countRows('taxonomy_fts');
  if (fts !== -1 && fts !== nodeCount) {
    out.push({
      id: fid('fts-drift'),
      checkId: 'fts-drift',
      severity: 'high',
      message: `FTS index has ${fts} rows but the taxonomy has ${nodeCount} nodes — search is missing content (restart rebuilds)`,
    });
  }
  const layout = db.countRows('taxonomy_layout');
  if (layout !== -1 && layout !== nodeCount) {
    out.push({
      id: fid('layout-drift'),
      checkId: 'layout-drift',
      severity: 'high',
      message: `Layout bake has ${layout} positions for ${nodeCount} nodes — spatial-memory contract broken (restart rebakes)`,
    });
  }
  if (db.vectorSearchAvailable()) {
    const { total } = pendingEmbeddings(1);
    if (total > 0) {
      out.push({
        id: fid('embedding-backlog'),
        checkId: 'embedding-backlog',
        severity: 'medium',
        message: `${total} corpus item(s) lack a current embedding — keap-embed-sync has not caught up`,
        data: { pending: total },
      });
    }
  }
}

function pushPair(
  out: LintFinding[],
  checkId: string,
  severity: LintSeverity,
  p: { aKind: string; aRefId: string; bKind: string; bRefId: string; distance: number },
  message: string,
): void {
  out.push({
    id: fid(checkId, `${p.aKind}:${p.aRefId}`, `${p.bKind}:${p.bRefId}`),
    checkId,
    severity,
    refKind: p.aKind,
    refId: p.aRefId,
    message,
    data: {
      a: { kind: p.aKind, refId: p.aRefId, name: label(p.aKind, p.aRefId) },
      b: { kind: p.bKind, refId: p.bRefId, name: label(p.bKind, p.bRefId) },
      distance: Number(p.distance.toFixed(4)),
    },
  });
}

function checkVectorPairs(out: LintFinding[]): void {
  if (!db.vectorSearchAvailable()) return;
  // Content kinds: duplicates + overlap candidates for the librarian queue.
  const pairs = db.nearPairs(['object', 'capture', 'note'], OVERLAP_DISTANCE, PAIR_LIMIT);
  for (const p of pairs) {
    const a = label(p.aKind, p.aRefId);
    const b = label(p.bKind, p.bRefId);
    if (p.distance < DUP_DISTANCE) {
      pushPair(out, 'near-duplicate', 'low', p,
        `"${a}" and "${b}" are near-identical (d=${p.distance.toFixed(3)}) — merge candidates`);
    } else {
      pushPair(out, 'overlap-review', 'info', p,
        `"${a}" and "${b}" cover the same ground (d=${p.distance.toFixed(3)}) — librarian queue: duplicate or contradiction?`);
    }
  }
  // Taxonomy twins: near-identical wording inside the tree itself.
  for (const p of db.nearPairs(['taxonomy'], TWIN_DISTANCE, PAIR_LIMIT)) {
    const a = label('taxonomy', p.aRefId);
    const b = label('taxonomy', p.bRefId);
    pushPair(out, 'taxonomy-twin', 'info', p,
      `Taxonomy nodes "${a}" (${p.aRefId}) and "${b}" (${p.bRefId}) read near-identically (d=${p.distance.toFixed(3)})`);
  }
}

function checkKnowledgeDeserts(out: LintFinding[]): void {
  // A level-1 subcategory whose whole subtree carries zero content — no
  // content link, no curated note, no anchored object — is a desert: the
  // universe renders stars there but nothing behind them.
  const notes = db.getTaxonomyMetadata();
  const notedIds = new Set((Array.isArray(notes) ? notes : []).map((n) => n.id));
  const anchored = new Set<string>();
  for (const o of db.getObjects('', true)) {
    for (const a of anchorNodeIds((o.links ?? []) as ObjectRef[])) anchored.add(a);
  }
  const nodes = allNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const subtreeHasContent = (n: FlatNode): boolean => {
    if (n.requiredData || notedIds.has(n.id) || anchored.has(n.id)) return true;
    return n.childIds.some((cid) => {
      const c = byId.get(cid);
      return c ? subtreeHasContent(c) : false;
    });
  };

  for (const n of nodes) {
    if (n.kind !== 'subcategory') continue;
    const parent = n.parentId ? byId.get(n.parentId) : null;
    if (!parent || parent.kind !== 'category') continue; // level-1 only
    if (!subtreeHasContent(n)) {
      out.push({
        id: fid('knowledge-desert', n.id),
        checkId: 'knowledge-desert',
        severity: 'info',
        refKind: 'taxonomy',
        refId: n.id,
        message: `Branch "${parent.name} > ${n.name}" has no content anywhere in its subtree — a knowledge desert`,
      });
    }
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

const CHECKS: Array<[string, (out: LintFinding[]) => void]> = [
  ['note-on-unknown-node', checkNoteAnchors],
  ['object-anchors', checkObjectAnchors],
  ['curated-content-refs', checkCuratedContentRefs],
  ['stale-captures', checkStaleCaptures],
  ['substrate', checkSubstrate],
  ['vector-pairs', checkVectorPairs],
  ['knowledge-deserts', checkKnowledgeDeserts],
];

export function runLint(): LintReport {
  const findings: LintFinding[] = [];
  const ranChecks: string[] = [];
  for (const [name, check] of CHECKS) {
    ranChecks.push(name);
    check(findings); // checks are pure reads; a throw here is a real bug
  }
  const { newIds, resolvedIds } = db.syncLintFindings(findings);
  return buildReport(ranChecks, new Set(newIds), resolvedIds.length);
}

export function lastLintReport(): LintReport {
  return buildReport([], new Set(), 0);
}

function buildReport(ranChecks: string[], newIds: Set<string>, resolved: number): LintReport {
  const open = db.getLintFindings(false);
  const counts: Record<LintSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const newBySeverity: Record<string, number> = {};
  for (const f of open) {
    counts[f.severity as LintSeverity] = (counts[f.severity as LintSeverity] ?? 0) + 1;
    if (newIds.has(f.id)) {
      newBySeverity[f.severity] = (newBySeverity[f.severity] ?? 0) + 1;
    }
  }
  return {
    ranChecks,
    counts,
    open: open.length,
    new: newIds.size,
    resolved,
    newBySeverity,
    findings: open,
  };
}
