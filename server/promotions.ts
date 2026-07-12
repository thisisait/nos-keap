/**
 * Promotion proposals — the MODERATED bridge from the review queue into the
 * curated corpus (the missing piece of the dream cycle).
 *
 * Flow: consolidator/devices/agents feed DATAPOINTS into the queue → the
 * librarian (or a human) PROPOSES a promotion (capture → knowledge object
 * draft with [[taxonomy anchors]]) → the MODERATOR has the final word.
 * Nothing an LLM proposes ever reaches the curated corpus on its own.
 *
 * Moderation policy (KEAP_MODERATION_POLICY):
 *   local       (default) — the nos-admins operator decides in Admin ›
 *               Moderation (or POST /api/promotions/:id/decide). Votes are
 *               recorded but advisory.
 *   democratic  — the MMO seed: any authenticated user votes; the proposal
 *               auto-approves at +KEAP_MODERATION_QUORUM net approvals and
 *               auto-rejects at -quorum. Deferred-by-doctrine until the
 *               sharing phase ships (same status as spatial-memory
 *               consensus); the data model is ready, single-instance
 *               deployments keep policy=local.
 *
 * Approval side-effects: the object is created through the SAME write path
 * agents/humans use (links extracted from body), attributed to the proposer,
 * with full provenance in frontmatter {promotedFrom, proposedBy, approvedBy}.
 * The source capture stays in the queue with metadata.promotedTo — the
 * provenance chain from raw datapoint to curated knowledge stays walkable.
 */
import crypto from 'node:crypto';
import * as db from './db';
import { getNode } from './taxonomy';
import { extractRefs, anchorNodeIds, type ObjectRef } from './objects';
import { markCorpusDirty } from './search';

export type Decision = 'approve' | 'reject';

const POLICY = (process.env.KEAP_MODERATION_POLICY ?? 'local') as 'local' | 'democratic';
const QUORUM = Math.max(1, Number(process.env.KEAP_MODERATION_QUORUM ?? 3));

export function moderationPolicy(): { policy: string; quorum: number } {
  return { policy: POLICY, quorum: QUORUM };
}

export interface ObjectDraft {
  /** Optional pinned id (OKF import roundtrip) — approve materializes
   *  the object under THIS id instead of a fresh uuid. */
  id?: string;
  type: string;
  title: string;
  description?: string;
  body?: string;
  resource?: string;
  tags?: string[];
}

/** Validate a proposal draft; returns the broken anchors (must be []). */
function brokenAnchors(draft: ObjectDraft): string[] {
  const refs = extractRefs(draft.body, draft.resource) as ObjectRef[];
  return anchorNodeIds(refs).filter((a) => !getNode(a));
}

export function propose(
  captureId: string,
  draft: ObjectDraft,
  rationale: string | undefined,
  proposedBy: string,
): { id: string } {
  const capture = db.getAllMetadataApi('', true).find((c) => c.id === captureId);
  if (!capture) throw new Error(`unknown capture ${captureId}`);
  if (!draft?.type || !draft?.title) throw new Error('object draft needs type + title');
  const broken = brokenAnchors(draft);
  if (broken.length) throw new Error(`draft anchors unknown taxonomy nodes: ${broken.join(', ')}`);
  // One open proposal per capture — a re-proposal updates it.
  const existing = db
    .listPromotions('proposed')
    .find((p) => p.captureId === captureId);
  const id = existing?.id ?? crypto.randomUUID();
  db.upsertPromotion({
    id,
    captureId,
    proposedBy,
    rationale: rationale?.slice(0, 1000),
    object: draft,
  });
  return { id };
}

export function vote(
  promotionId: string,
  by: string,
  value: 1 | -1,
): { status: string; net: number } {
  const p = db.getPromotion(promotionId);
  if (!p) throw new Error('unknown promotion');
  if (p.status !== 'proposed') throw new Error(`promotion already ${p.status}`);
  const votes = p.votes.filter((v) => v.by !== by); // one vote per identity
  votes.push({ by, value, at: Math.floor(Date.now() / 1000) });
  db.setPromotionVotes(promotionId, votes);
  const net = votes.reduce((s, v) => s + v.value, 0);
  // Democratic policy: quorum executes the decision, attributed to the
  // electorate. Local policy: votes are advisory; only decide() executes.
  if (POLICY === 'democratic') {
    if (net >= QUORUM) return { status: decide(promotionId, 'approve', `quorum:${net}`).status, net };
    if (net <= -QUORUM) return { status: decide(promotionId, 'reject', `quorum:${net}`).status, net };
  }
  return { status: 'proposed', net };
}

export function decide(
  promotionId: string,
  decision: Decision,
  decidedBy: string,
): { status: string; objectId?: string } {
  const p = db.getPromotion(promotionId);
  if (!p) throw new Error('unknown promotion');
  if (p.status !== 'proposed') throw new Error(`promotion already ${p.status}`);

  if (decision === 'reject') {
    db.setPromotionDecision(promotionId, 'rejected', decidedBy, null);
    return { status: 'rejected' };
  }

  if ((p as any).kind === 'node') {
    const { nodeId } = materializeNode(promotionId, decidedBy);
    return { status: 'approved', objectId: nodeId };
  }

  if ((p as any).kind === 'desc') {
    const { nodeId } = materializeDescription(promotionId, decidedBy);
    return { status: 'approved', objectId: nodeId };
  }

  if ((p as any).kind === 'brief') {
    const { nodeId } = materializeBrief(promotionId, decidedBy);
    return { status: 'approved', objectId: nodeId };
  }

  // Approve: materialize the object through the standard write path.
  const draft = p.object as ObjectDraft;
  const broken = brokenAnchors(draft);
  if (broken.length) throw new Error(`draft anchors vanished from taxonomy: ${broken.join(', ')}`);
  const objectId = draft.id ?? crypto.randomUUID();
  db.saveObject(p.proposedBy, {
    id: objectId,
    type: draft.type,
    title: draft.title,
    description: draft.description,
    resource: draft.resource,
    tags: draft.tags,
    frontmatter: {
      promotedFrom: p.captureId,
      proposedBy: p.proposedBy,
      approvedBy: decidedBy,
      rationale: p.rationale,
    },
    body: draft.body,
    links: extractRefs(draft.body, draft.resource),
    visibility: 'private',
  });
  db.markCapturePromoted(p.captureId, objectId);
  db.setPromotionDecision(promotionId, 'approved', decidedBy, objectId);
  markCorpusDirty();
  return { status: 'approved', objectId };
}

// ── Taxonomy extension proposals (Track T) ────────────────────────────────────
// Same moderated machinery, kind='node'. Governance is keyed on the PARENT's
// zone: anchor core refuses (the sky's constants change only by release),
// votable core requires moderation, free zone approves lightly (auto —
// append-only depth where most datapoints live).

import { registerExtNode, nodeLevel, zoneOfLevel, allNodes, applyDescriptionOverride } from './taxonomy';
import { appendExtNodeToLayout } from './layout';
import { rebuildTaxonomyFts } from './db';

export interface NodeDraft {
  parentId: string;
  name: string;
  description: string;
}

export function proposeNode(
  draft: NodeDraft,
  rationale: string | undefined,
  proposedBy: string,
): { id: string; status: string; nodeId?: string } {
  const parent = getNode(draft?.parentId ?? '');
  if (!parent) throw new Error(`unknown parent node ${draft?.parentId}`);
  if (!draft.name?.trim()) throw new Error('name is required');
  // DescGraph doctrine (arXiv 2601.01280): descriptions are load-bearing —
  // an entity-relation graph with natural-language descriptions beats every
  // other memory structure. A node without a description would be dead
  // weight in search, embeddings and the librarian's judgment alike.
  if (!draft.description || draft.description.trim().length < 20) {
    throw new Error(
      'description is required (min 20 chars): descriptions are load-bearing — ' +
      'the node exists for search/embeddings only through its description (DescGraph doctrine)',
    );
  }
  if (parent.zone === 'anchor') {
    throw new Error(
      `parent "${parent.name}" is ANCHOR CORE (level ${nodeLevel(parent.id)}) — ` +
      'the sky\'s constants change only by release, not by proposal',
    );
  }
  const name = draft.name.trim().slice(0, 120);
  const dup = parent.childIds
    .map((id) => getNode(id))
    .find((n) => n && n.name.toLowerCase() === name.toLowerCase());
  if (dup) throw new Error(`"${name}" already exists under "${parent.name}" (${dup.id})`);

  const normalized: NodeDraft = {
    parentId: parent.id,
    name,
    description: draft.description.trim().slice(0, 2000),
  };

  const existing = db
    .listPromotions('proposed')
    .find((p) => (p as any).kind === 'node' && p.object?.parentId === parent.id
      && String(p.object?.name).toLowerCase() === name.toLowerCase());
  const id = existing?.id ?? crypto.randomUUID();
  db.upsertPromotion({ id, kind: 'node', captureId: `node:${parent.id}`, proposedBy, rationale: rationale?.slice(0, 1000), object: normalized });

  // Free zone approves lightly: materialize immediately, still recorded as
  // an approved proposal (full audit trail, moderator can prune later).
  if (parent.zone === 'free') {
    const { nodeId } = materializeNode(id, 'auto:free-zone');
    return { id, status: 'approved', nodeId };
  }
  return { id, status: 'proposed' };
}

// ── Curated node descriptions (Track K, K1 taxonomy-describe) ─────────────────
// Same moderated machinery, kind='desc'. Descriptions are METADATA, not
// structure: they never move stars (the layout version hashes id>parent
// only), so they are proposable for EVERY zone including the anchor core —
// but always moderated (LLM writes propose, humans dispose). The Admin
// bulk-approve exists because K1 lands hundreds at once.

export interface DescDraft {
  nodeId: string;
  descriptionEn: string;
  descriptionCs?: string;
}

export function proposeDescription(
  draft: DescDraft,
  rationale: string | undefined,
  proposedBy: string,
): { id: string; status: string } {
  const node = getNode(draft?.nodeId ?? '');
  if (!node) throw new Error(`unknown node ${draft?.nodeId}`);
  // DescGraph doctrine: the description IS the node's retrieval text.
  if (!draft.descriptionEn || draft.descriptionEn.trim().length < 20) {
    throw new Error('descriptionEn is required (min 20 chars): it becomes the node\'s search/embedding text');
  }
  if (draft.descriptionCs !== undefined && draft.descriptionCs.trim().length < 20) {
    throw new Error('descriptionCs, when given, must carry real text (min 20 chars)');
  }
  const normalized: DescDraft = {
    nodeId: node.id,
    descriptionEn: draft.descriptionEn.trim().slice(0, 2000),
    descriptionCs: draft.descriptionCs?.trim().slice(0, 2000),
  };
  if (normalized.descriptionEn === node.description) {
    throw new Error('identical to the current description — nothing to propose');
  }
  // One open desc proposal per node — a re-proposal updates it.
  const existing = db
    .listPromotions('proposed')
    .find((p) => (p as any).kind === 'desc' && p.object?.nodeId === node.id);
  const id = existing?.id ?? crypto.randomUUID();
  db.upsertPromotion({
    id,
    kind: 'desc',
    captureId: `desc:${node.id}`,
    proposedBy,
    rationale: rationale?.slice(0, 1000),
    object: normalized,
  });
  return { id, status: 'proposed' };
}

/** Approve side-effect for kind='desc': override + re-wire every consumer. */
export function materializeDescription(promotionId: string, decidedBy: string): { nodeId: string } {
  const p = db.getPromotion(promotionId);
  if (!p) throw new Error('unknown promotion');
  const draft = p.object as DescDraft;
  const node = getNode(draft.nodeId);
  if (!node) throw new Error(`node ${draft.nodeId} vanished`);
  db.upsertNodeDescription({
    nodeId: draft.nodeId,
    descriptionEn: draft.descriptionEn,
    descriptionCs: draft.descriptionCs,
    proposedBy: p.proposedBy,
    approvedBy: decidedBy,
  });
  applyDescriptionOverride({ nodeId: draft.nodeId, descriptionEn: draft.descriptionEn, descriptionCs: draft.descriptionCs });
  // Consumer-first (llms.txt lesson): FTS + corpus flip in the same step;
  // the embeddings pending diff picks the changed content_hash up next sync.
  rebuildTaxonomyFts(allNodes());
  markCorpusDirty();
  db.setPromotionDecision(promotionId, 'approved', decidedBy, draft.nodeId);
  return { nodeId: draft.nodeId };
}

// ── Node briefs (Track K, taxonomy-brief) ─────────────────────────────────────
// Several explanatory PARAGRAPHS with LINKS per node — the node's article,
// where the K1 description is its abstract. Briefs live in the curated note
// layer (taxonomy_metadata.data.brief*), which the embeddings (kind 'note'),
// the agent node detail and the lint already consume — no new read paths.
// kind='brief' promotions: agents/humans propose, the moderator disposes.
// [[node-id]] refs are the VAZBY: validated against the live tree, at least
// one required, rendered clickable in the explorer's DetailPanel.

export interface BriefDraft {
  nodeId: string;
  /** Markdown, >=2 paragraphs — canonical (en). */
  briefEn: string;
  /** Markdown, cs localization. */
  briefCs?: string;
}

function briefRefs(md: string): string[] {
  return anchorNodeIds(extractRefs(md, undefined) as ObjectRef[]);
}

export function proposeBrief(
  draft: BriefDraft,
  rationale: string | undefined,
  proposedBy: string,
): { id: string; status: string } {
  const node = getNode(draft?.nodeId ?? '');
  if (!node) throw new Error(`unknown node ${draft?.nodeId}`);
  const en = (draft.briefEn ?? '').trim();
  if (en.length < 300 || en.length > 12000) {
    throw new Error('briefEn must be 300-12000 chars — several real paragraphs, not a caption');
  }
  if (en.split(/\n\s*\n/).filter((p) => p.trim()).length < 2) {
    throw new Error('briefEn needs at least 2 paragraphs (blank-line separated)');
  }
  const cs = draft.briefCs?.trim();
  if (cs !== undefined && (cs.length < 200 || cs.length > 12000)) {
    throw new Error('briefCs, when given, must carry real paragraphs (200-12000 chars)');
  }
  const refs = briefRefs(en);
  const broken = refs.filter((r) => !getNode(r));
  if (broken.length) throw new Error(`brief links unknown taxonomy nodes: ${broken.join(', ')}`);
  if (!refs.length) {
    throw new Error('brief must link at least one related [[node-id]] — briefs carry the vazby');
  }
  const normalized: BriefDraft = { nodeId: node.id, briefEn: en, briefCs: cs };
  const existing = db
    .listPromotions('proposed')
    .find((p) => (p as any).kind === 'brief' && p.object?.nodeId === node.id);
  const id = existing?.id ?? crypto.randomUUID();
  db.upsertPromotion({
    id,
    kind: 'brief',
    captureId: `brief:${node.id}`,
    proposedBy,
    rationale: rationale?.slice(0, 1000),
    object: normalized,
  });
  return { id, status: 'proposed' };
}

/** Approve side-effect for kind='brief': merge into the curated note layer. */
export function materializeBrief(promotionId: string, decidedBy: string): { nodeId: string } {
  const p = db.getPromotion(promotionId);
  if (!p) throw new Error('unknown promotion');
  const draft = p.object as BriefDraft;
  const node = getNode(draft.nodeId);
  if (!node) throw new Error(`node ${draft.nodeId} vanished`);
  const broken = briefRefs(draft.briefEn).filter((r) => !getNode(r));
  if (broken.length) throw new Error(`brief links vanished from taxonomy: ${broken.join(', ')}`);
  const row = db.getTaxonomyMetadata(draft.nodeId);
  const data = row && !Array.isArray(row) ? { ...(row.data ?? {}) } : {};
  data.brief = draft.briefEn;
  if (draft.briefCs) data.briefCs = draft.briefCs;
  data.briefMeta = { proposedBy: p.proposedBy, approvedBy: decidedBy };
  db.saveTaxonomyMetadata({ id: draft.nodeId, data }, p.proposedBy);
  // The note-kind embedding goes stale via content_hash; search flips now.
  markCorpusDirty();
  db.setPromotionDecision(promotionId, 'approved', decidedBy, draft.nodeId);
  return { nodeId: draft.nodeId };
}

/** Approve side-effect for kind='node': grow the tree + wire every consumer. */
export function materializeNode(promotionId: string, decidedBy: string): { nodeId: string } {
  const p = db.getPromotion(promotionId);
  if (!p) throw new Error('unknown promotion');
  const draft = p.object as NodeDraft;
  const parent = getNode(draft.parentId);
  if (!parent) throw new Error(`parent ${draft.parentId} vanished`);

  // Child id = next numeric suffix among ALL siblings (static + grown).
  const used = parent.childIds
    .map((cid) => Number(cid.split('.').pop()))
    .filter((n) => Number.isInteger(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  const nodeId = `${parent.id}.${String(next).padStart(2, '0')}`;
  const zone = zoneOfLevel(nodeLevel(parent.id) + 1);
  const ordinal = db.extChildCount(parent.id);

  db.insertExtNode({
    id: nodeId,
    parentId: parent.id,
    name: draft.name,
    description: draft.description,
    zone,
    ordinal,
    proposedBy: p.proposedBy,
    approvedBy: decidedBy,
  });
  // "An index without a consumer dies" (llms.txt lesson) — the node joins
  // EVERY read path in the same step: tree, FTS, layout, hybrid search;
  // the embeddings pending diff includes it on the next sync pass.
  registerExtNode({ id: nodeId, parentId: parent.id, name: draft.name, description: draft.description, zone });
  rebuildTaxonomyFts(allNodes());
  appendExtNodeToLayout({ id: nodeId, parentId: parent.id, ordinal });
  markCorpusDirty();
  db.setPromotionDecision(promotionId, 'approved', decidedBy, nodeId);
  return { nodeId };
}
