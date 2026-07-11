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

  // Approve: materialize the object through the standard write path.
  const draft = p.object as ObjectDraft;
  const broken = brokenAnchors(draft);
  if (broken.length) throw new Error(`draft anchors vanished from taxonomy: ${broken.join(', ')}`);
  const objectId = crypto.randomUUID();
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
