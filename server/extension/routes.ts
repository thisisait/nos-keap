import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import * as db from '../db';
import { normalizeAndSaveCapture } from '../intake';
import { extractRefs } from '../objects';
import { hybridSearch, markCorpusDirty } from '../search';
import { allNodes, getAncestors, getNode } from '../taxonomy';
import { proposeBrief, proposeDescription, proposeNode } from '../promotions';
import {
  EXTENSION_PROTOCOL_VERSION,
  contextInputSchema,
  draftInputSchema,
  extensionCaptureInputSchema,
  extensionObjectInputSchema,
  pairingExchangeSchema,
  pairingStartSchema,
} from '../../shared/contracts/extension';
import { extensionAuth, requireExtensionScope } from './auth';
import {
  audit,
  createDraft,
  createPairing,
  deleteDraft,
  exchangePairing,
  getDraftForUser,
} from './store';

const ok = (res: Response, data?: unknown, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error });

const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

function pairingRateLimited(req: Request): boolean {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) {
    pairingAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > 20;
}

function parse<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  fail(res, 400, result.error.issues[0]?.message ?? 'invalid request');
  return null;
}

function identity(req: Request) {
  if (!req.extensionIdentity) throw new Error('extension identity missing');
  return req.extensionIdentity;
}

function contextHit(hit: { kind: db.EmbeddingKind; refId: string; score: number; legs: string[] }) {
  if (hit.kind === 'taxonomy') {
    const node = getNode(hit.refId);
    return node
      ? { ...hit, title: node.name, description: node.description, nodeId: node.id, path: node.path }
      : null;
  }
  if (hit.kind === 'capture') {
    const capture = db.getMetadataApi(hit.refId);
    return capture
      ? { ...hit, title: capture.title, description: capture.description, url: capture.url, domain: capture.domain }
      : null;
  }
  if (hit.kind === 'object') {
    const object = db.getObject(hit.refId);
    if (!object) return null;
    const links = (object.links ?? []) as { kind?: string; ref?: string }[];
    const anchors = links.filter((link) => link.kind === 'node' && link.ref).map((link) => link.ref as string);
    return {
      ...hit,
      title: object.title,
      description: object.description,
      resource: object.resource,
      type: object.type,
      anchors,
    };
  }
  const note = db.getTaxonomyMetadata(hit.refId);
  const node = getNode(hit.refId);
  return note && !Array.isArray(note)
    ? { ...hit, title: node?.name ?? hit.refId, description: note.data?.brief, nodeId: node?.id }
    : null;
}

function setCorsHeaders(res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

export function registerExtensionRoutes(app: Express) {
  app.use('/ext/v1', (req: Request, res: Response, next: NextFunction) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/ext/v1/health', (req, res) => {
    const publicUrl = process.env.KEAP_PUBLIC_URL?.replace(/\/$/, '') ?? null;
    ok(res, {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      instanceId: process.env.KEAP_INSTANCE_ID ?? process.env.KEAP_TENANT_DOMAIN ?? 'local',
      displayName: process.env.KEAP_INSTANCE_NAME ?? 'KEAP',
      canonicalOrigin: publicUrl,
      capabilities: ['pairing', 'context', 'captures', 'objects', 'taxonomy', 'drafts'],
    });
  });

  app.post('/ext/v1/pairings', (req, res) => {
    if (pairingRateLimited(req)) return fail(res, 429, 'too many pairing attempts');
    const input = parse(pairingStartSchema, req.body, res);
    if (!input) return;
    const pairing = createPairing(input);
    ok(
      res,
      {
        pairingId: pairing.id,
        userCode: pairing.userCode,
        verificationPath: `/extension/pair?code=${encodeURIComponent(pairing.userCode)}`,
        expiresAt: pairing.expiresAt,
        intervalSeconds: 3,
      },
      201,
    );
  });

  app.post('/ext/v1/pairings/exchange', (req, res) => {
    if (pairingRateLimited(req)) return fail(res, 429, 'too many pairing attempts');
    const input = parse(pairingExchangeSchema, req.body, res);
    if (!input) return;
    const credential = exchangePairing(input.pairingId, input.deviceSecret);
    if (!credential) return fail(res, 428, 'pairing pending, expired or invalid');
    audit(null, 'extension.paired', 'credential', credential.credentialId);
    ok(res, credential, 201);
  });

  app.use('/ext/v1', extensionAuth);

  app.get('/ext/v1/me', (req, res) => {
    const ext = identity(req);
    ok(res, {
      id: ext.user.id,
      username: ext.user.username,
      name: ext.user.name,
      email: ext.user.email,
      clientName: ext.clientName,
      scopes: ext.scopes,
    });
  });

  app.post('/ext/v1/context/resolve', requireExtensionScope('context:read'), async (req, res) => {
    const ext = identity(req);
    const input = parse(contextInputSchema, req.body, res);
    if (!input) return;
    const query = [input.title, input.description, input.selection, input.excerpt]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4_000);
    const result = await hybridSearch(
      query,
      ['taxonomy', 'capture', 'note', 'object'],
      25,
      { userId: ext.user.id, seeAll: false },
    );
    const items = result.hits.map(contextHit).filter(Boolean);
    let domain: string | undefined;
    try {
      domain = new URL(input.url).hostname;
    } catch {
      domain = undefined;
    }
    const onDomain = domain ? db.getMetadataByDomainApi(ext.user.id, false, domain).slice(0, 10) : [];
    audit(ext, 'context.resolved', 'url', undefined, { domain, selection: Boolean(input.selection) });
    ok(res, { items, onDomain, legs: result.legs });
  });

  app.get('/ext/v1/captures', requireExtensionScope('context:read'), (req, res) => {
    const ext = identity(req);
    const domain = req.query.domain ? String(req.query.domain) : undefined;
    const captures = domain
      ? db.getMetadataByDomainApi(ext.user.id, false, domain)
      : db.getAllMetadataApi(ext.user.id, false);
    ok(res, captures.slice(0, Math.min(Number(req.query.limit) || 50, 100)));
  });

  app.post('/ext/v1/captures', requireExtensionScope('capture:write'), (req, res) => {
    const ext = identity(req);
    const input = parse(extensionCaptureInputSchema, req.body, res);
    if (!input) return;
    const capture = {
      id: input.id ?? crypto.randomUUID(),
      source: { kind: 'extension' as const, name: ext.clientName },
      modality: input.url ? 'url' : 'text',
      title: input.title,
      text: input.text,
      url: input.url,
      domain: input.domain,
      capturedAt: input.capturedAt,
      tags: input.tags,
      metadata: input.metadata,
    };
    const saved = normalizeAndSaveCapture(capture, ext.user.id);
    markCorpusDirty();
    audit(ext, 'capture.created', 'capture', saved.id, { modality: capture.modality });
    ok(res, { ...saved, queued: true }, 201);
  });

  app.get('/ext/v1/objects', requireExtensionScope('objects:read'), (req, res) => {
    const ext = identity(req);
    const type = req.query.type ? String(req.query.type) : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const objects = db.getObjects(ext.user.id, false, type);
    ok(res, { items: objects.slice(offset, offset + limit), total: objects.length, offset, limit });
  });

  app.get('/ext/v1/objects/:id', requireExtensionScope('objects:read'), (req, res) => {
    const ext = identity(req);
    const object = db.getObject(req.params.id);
    if (!object || object.userId !== ext.user.id) return fail(res, 404, 'unknown object');
    ok(res, object);
  });

  app.post('/ext/v1/objects', requireExtensionScope('objects:write'), (req, res) => {
    const ext = identity(req);
    const input = parse(extensionObjectInputSchema, req.body, res);
    if (!input) return;
    const id = input.id ?? crypto.randomUUID();
    const existing = db.getObject(id);
    if (existing && existing.userId !== ext.user.id) return fail(res, 403, 'not your object');
    db.saveObject(ext.user.id, {
      id,
      type: input.type,
      title: input.title,
      description: input.description,
      resource: input.resource,
      tags: input.tags,
      frontmatter: input.frontmatter,
      body: input.body,
      links: extractRefs(input.body, input.resource),
      visibility: input.visibility,
    });
    markCorpusDirty();
    audit(ext, existing ? 'object.updated' : 'object.created', 'object', id);
    ok(res, db.getObject(id), existing ? 200 : 201);
  });

  app.get('/ext/v1/taxonomy/tree', requireExtensionScope('taxonomy:read'), (_req, res) => {
    ok(
      res,
      allNodes().map((node) => ({
        id: node.id,
        name: node.name,
        description: node.description,
        descriptionCs: node.descriptionCs,
        parentId: node.parentId,
        path: node.path,
        kind: node.kind,
        zone: node.zone,
        childCount: node.childIds.length,
        ext: node.ext ?? false,
      })),
    );
  });

  app.get('/ext/v1/taxonomy/nodes/:id', requireExtensionScope('taxonomy:read'), (req, res) => {
    const node = getNode(req.params.id);
    if (!node) return fail(res, 404, 'unknown taxonomy node');
    ok(res, {
      ...node,
      ancestors: getAncestors(node.id),
      children: node.childIds.map((id) => getNode(id)).filter(Boolean),
    });
  });

  app.get('/ext/v1/taxonomy/search', requireExtensionScope('taxonomy:read'), (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) return fail(res, 400, 'q required');
    const hits = db.searchTaxonomyFts(query, Math.min(Number(req.query.limit) || 20, 50));
    ok(
      res,
      hits.map((hit) => ({ ...hit, node: getNode(hit.id) })).filter((hit) => hit.node),
    );
  });

  app.post('/ext/v1/taxonomy/proposals/node', requireExtensionScope('taxonomy:propose'), (req, res) => {
    const ext = identity(req);
    const input = parse(
      z.object({
        parentId: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().min(20).max(2_000),
        rationale: z.string().max(1_000).optional(),
      }),
      req.body,
      res,
    );
    if (!input) return;
    try {
      const result = proposeNode(input, input.rationale, ext.user.id);
      audit(ext, 'taxonomy.node.proposed', 'taxonomy', result.nodeId ?? result.id);
      ok(res, result, 201);
    } catch (error) {
      fail(res, 400, (error as Error).message);
    }
  });

  app.post('/ext/v1/taxonomy/proposals/description', requireExtensionScope('taxonomy:propose'), (req, res) => {
    const ext = identity(req);
    const input = parse(
      z.object({
        nodeId: z.string().min(1),
        descriptionEn: z.string().trim().min(20).max(4_000),
        descriptionCs: z.string().max(4_000).optional(),
        rationale: z.string().max(1_000).optional(),
      }),
      req.body,
      res,
    );
    if (!input) return;
    try {
      const result = proposeDescription(input, input.rationale, ext.user.id);
      audit(ext, 'taxonomy.description.proposed', 'taxonomy', input.nodeId);
      ok(res, result, 201);
    } catch (error) {
      fail(res, 400, (error as Error).message);
    }
  });

  app.post('/ext/v1/taxonomy/proposals/brief', requireExtensionScope('taxonomy:propose'), (req, res) => {
    const ext = identity(req);
    const input = parse(
      z.object({
        nodeId: z.string().min(1),
        briefEn: z.string().trim().min(20).max(12_000),
        briefCs: z.string().max(12_000).optional(),
        rationale: z.string().max(1_000).optional(),
      }),
      req.body,
      res,
    );
    if (!input) return;
    try {
      const result = proposeBrief(input, input.rationale, ext.user.id);
      audit(ext, 'taxonomy.brief.proposed', 'taxonomy', input.nodeId);
      ok(res, result, 201);
    } catch (error) {
      fail(res, 400, (error as Error).message);
    }
  });

  app.post('/ext/v1/drafts', requireExtensionScope('drafts:write'), (req, res) => {
    const ext = identity(req);
    const input = parse(draftInputSchema, req.body, res);
    if (!input) return;
    const draft = createDraft(ext, input.kind, input.payload, input.ttlSeconds ?? 86_400);
    audit(ext, 'draft.created', 'draft', draft.id, { kind: input.kind });
    ok(res, { ...draft, composePath: `/compose/${draft.id}` }, 201);
  });

  app.get('/ext/v1/drafts/:id', requireExtensionScope('drafts:write'), (req, res) => {
    const draft = getDraftForUser(req.params.id, identity(req).user.id);
    if (!draft) return fail(res, 404, 'unknown or expired draft');
    ok(res, draft);
  });

  app.delete('/ext/v1/drafts/:id', requireExtensionScope('drafts:write'), (req, res) => {
    const ext = identity(req);
    if (!deleteDraft(req.params.id, ext.user.id)) return fail(res, 404, 'unknown draft');
    audit(ext, 'draft.deleted', 'draft', req.params.id);
    ok(res);
  });

}
