import crypto from 'node:crypto';
import * as db from '../db';
import type { KeapUser } from '../identity';
import {
  DEFAULT_EXTENSION_SCOPES,
  extensionScopeSchema,
  type ExtensionScope,
} from '../../shared/contracts/extension';

const PAIRING_TTL_SECONDS = 10 * 60;
const CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface ExtensionIdentity {
  credentialId: string;
  user: KeapUser;
  clientName: string;
  scopes: ExtensionScope[];
}

interface PairingRow {
  id: string;
  user_code: string;
  device_secret_hash: string;
  client_name: string;
  requested_scopes?: string;
  approved_scopes?: string;
  status: string;
  expires_at: number;
  user_id?: string;
  username?: string;
  name?: string;
  email?: string;
}

interface CredentialRow {
  id: string;
  token_hash: string;
  user_id: string;
  username: string;
  name: string;
  email: string;
  client_name: string;
  scopes: string;
  status: string;
  expires_at: number;
  last_used_at?: number;
  created_at?: number;
  revoked_at?: number;
}

interface DraftRow {
  id: string;
  credential_id: string;
  owner_id: string;
  kind: string;
  payload: string;
  expires_at: number;
  consumed_at?: number;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function userCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function parseScopes(raw: string | null | undefined): ExtensionScope[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return extensionScopeSchema.array().parse(parsed);
}

export function createPairing(input: {
  clientName: string;
  deviceSecret: string;
  scopes: ExtensionScope[];
}): { id: string; userCode: string; expiresAt: number } {
  const d = db.getDb();
  const id = crypto.randomUUID();
  const code = userCode();
  const expiresAt = Math.floor(Date.now() / 1000) + PAIRING_TTL_SECONDS;
  d.prepare(
    `INSERT INTO extension_pairings
       (id, user_code, device_secret_hash, client_name, requested_scopes, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, code, hash(input.deviceSecret), input.clientName, JSON.stringify(input.scopes), expiresAt);
  return { id, userCode: code, expiresAt };
}

export function getPairingForApproval(code: string): {
  id: string;
  clientName: string;
  scopes: ExtensionScope[];
  status: string;
  expiresAt: number;
} | null {
  const row = db
    .getDb()
    .prepare('SELECT * FROM extension_pairings WHERE user_code = ?')
    .get(code.trim().toUpperCase()) as PairingRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    clientName: row.client_name,
    scopes: parseScopes(row.requested_scopes),
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export function approvePairing(code: string, user: KeapUser): boolean {
  const pairing = getPairingForApproval(code);
  const now = Math.floor(Date.now() / 1000);
  if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= now) return false;
  const scopes = pairing.scopes.filter((scope) => DEFAULT_EXTENSION_SCOPES.includes(scope));
  const result = db
    .getDb()
    .prepare(
      `UPDATE extension_pairings SET
         approved_scopes = ?, user_id = ?, username = ?, name = ?, email = ?,
         status = 'approved', approved_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .run(
      JSON.stringify(scopes),
      user.id,
      user.username,
      user.name,
      user.email,
      now,
      pairing.id,
      now,
    );
  return result.changes === 1;
}

export function exchangePairing(pairingId: string, deviceSecret: string): {
  token: string;
  credentialId: string;
  expiresAt: number;
  scopes: ExtensionScope[];
} | null {
  const d = db.getDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const credentialId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS;
  let output: { token: string; credentialId: string; expiresAt: number; scopes: ExtensionScope[] } | null = null;
  const exchange = d.transaction(() => {
    const row = d.prepare('SELECT * FROM extension_pairings WHERE id = ?').get(pairingId) as PairingRow | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (
      !row ||
      row.status !== 'approved' ||
      row.expires_at <= now ||
      !row.approved_scopes ||
      !secureEqual(row.device_secret_hash, hash(deviceSecret))
    ) {
      return;
    }
    const scopes = parseScopes(row.approved_scopes);
    d.prepare(
      `INSERT INTO extension_credentials
         (id, token_hash, user_id, username, name, email, client_name, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      credentialId,
      hash(token),
      row.user_id,
      row.username,
      row.name,
      row.email,
      row.client_name,
      JSON.stringify(scopes),
      expiresAt,
    );
    d.prepare("UPDATE extension_pairings SET status = 'consumed' WHERE id = ?").run(pairingId);
    output = { token, credentialId, expiresAt, scopes };
  });
  exchange();
  return output;
}

export function authenticateCredential(token: string): ExtensionIdentity | null {
  const tokenHash = hash(token);
  const row = db
    .getDb()
    .prepare('SELECT * FROM extension_credentials WHERE token_hash = ?')
    .get(tokenHash) as CredentialRow | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.status !== 'active' || row.expires_at <= now || !secureEqual(row.token_hash, tokenHash)) {
    return null;
  }
  db.getDb().prepare('UPDATE extension_credentials SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return {
    credentialId: row.id,
    clientName: row.client_name,
    scopes: parseScopes(row.scopes),
    user: {
      id: row.user_id,
      username: row.username,
      name: row.name ?? null,
      email: row.email ?? null,
      groups: [],
      isAdmin: false,
    },
  };
}

export function listCredentials(userId: string): Array<{
  id: string;
  clientName: string;
  scopes: ExtensionScope[];
  status: string;
  expiresAt: number;
  lastUsedAt?: number;
  createdAt: number;
}> {
  return (db
    .getDb()
    .prepare('SELECT * FROM extension_credentials WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as CredentialRow[]).map((row) => ({
    id: row.id,
    clientName: row.client_name,
    scopes: parseScopes(row.scopes),
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at ?? 0,
  }));
}

export function revokeCredential(userId: string, credentialId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .getDb()
    .prepare(
      "UPDATE extension_credentials SET status = 'revoked', revoked_at = ? WHERE id = ? AND user_id = ? AND status = 'active'",
    )
    .run(now, credentialId, userId);
  return result.changes === 1;
}

export function createDraft(
  identity: ExtensionIdentity,
  kind: string,
  payload: Record<string, unknown>,
  ttlSeconds: number,
): { id: string; expiresAt: number } {
  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  db.getDb()
    .prepare(
      `INSERT INTO extension_drafts
         (id, credential_id, owner_id, kind, payload, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, identity.credentialId, identity.user.id, kind, JSON.stringify(payload), expiresAt);
  return { id, expiresAt };
}

export function getDraftForUser(
  id: string,
  ownerId: string,
): { id: string; kind: string; payload: Record<string, unknown>; expiresAt: number; consumedAt?: number } | null {
  const row = db
    .getDb()
    .prepare('SELECT * FROM extension_drafts WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as DraftRow | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at <= now) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
  };
}

export function deleteDraft(id: string, ownerId: string): boolean {
  return db.getDb().prepare('DELETE FROM extension_drafts WHERE id = ? AND owner_id = ?').run(id, ownerId).changes === 1;
}

export function audit(
  identity: ExtensionIdentity | null,
  action: string,
  resourceKind?: string,
  resourceId?: string,
  detail?: Record<string, unknown>,
): void {
  db.getDb()
    .prepare(
      `INSERT INTO extension_audit_events
         (credential_id, user_id, action, resource_kind, resource_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identity?.credentialId ?? null,
      identity?.user.id ?? null,
      action,
      resourceKind ?? null,
      resourceId ?? null,
      detail ? JSON.stringify(detail) : null,
    );
}
