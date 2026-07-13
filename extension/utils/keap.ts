import { getState, setState, type ExtensionState } from './storage';

export const DEFAULT_EXTENSION_SCOPES = [
  'context:read',
  'capture:write',
  'objects:read',
  'objects:write',
  'types:read',
  'types:write',
  'taxonomy:read',
  'taxonomy:propose',
  'drafts:write',
];

interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function ensureHttp(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function keapApi(
  method: string,
  path: string,
  body?: unknown,
  options?: { instanceUrl?: string; token?: string | null },
): Promise<unknown> {
  const state = await getState();
  const baseUrl = normalizeInstanceUrl(ensureHttp(options?.instanceUrl ?? state.instanceUrl));
  const token = options?.token !== undefined ? options.token : state.token;
  const url = `${baseUrl}/ext/v1${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let envelope: ApiEnvelope;
  try {
    envelope = (await res.json()) as ApiEnvelope;
  } catch {
    throw new Error(`KEAP API ${path} returned non-JSON response (${res.status})`);
  }
  if (!res.ok || !envelope.success) {
    throw new Error(envelope.error ?? `KEAP API ${path} failed (${res.status})`);
  }
  return envelope.data;
}

export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return btoa(String.fromCharCode(...bytes));
}

interface PairingResponse {
  pairingId: string;
  userCode: string;
  verificationPath: string;
  expiresAt: number;
  intervalSeconds: number;
}

export async function startPairing(instanceUrl: string, clientName = 'KEAP Companion') {
  const deviceSecret = generateSecret();
  const url = normalizeInstanceUrl(ensureHttp(instanceUrl));
  const data = (await keapApi(
    'POST',
    '/pairings',
    { clientName, deviceSecret, scopes: DEFAULT_EXTENSION_SCOPES },
    { instanceUrl: url, token: null },
  )) as PairingResponse;

  await setState({
    pendingPairing: {
      ...data,
      deviceSecret,
      instanceUrl: url,
    },
    instanceUrl: url,
  });

  return { ...data, deviceSecret, instanceUrl: url };
}

interface ExchangeResponse {
  token: string;
  credentialId: string;
  expiresAt: number;
  scopes: string[];
}

export async function checkPairing(instanceUrl: string, pairingId: string, deviceSecret: string) {
  const url = normalizeInstanceUrl(ensureHttp(instanceUrl));
  const data = (await keapApi(
    'POST',
    '/pairings/exchange',
    { pairingId, deviceSecret },
    { instanceUrl: url, token: null },
  )) as ExchangeResponse;

  const next = await setState({
    instanceUrl: url,
    token: data.token,
    credentialId: data.credentialId,
    scopes: data.scopes,
    expiresAt: data.expiresAt,
    pairedAt: Date.now(),
    pendingPairing: null,
  });

  return { ...data, ...next };
}

export async function getMe() {
  const data = (await keapApi('GET', '/me')) as ExtensionState['user'];
  await setState({ user: data });
  return data;
}

export async function resolveContext(input: {
  url: string;
  title: string;
  description?: string;
  selection?: string;
  excerpt?: string;
}) {
  return keapApi('POST', '/context/resolve', input);
}

export async function saveCapture(input: {
  title: string;
  text: string;
  url?: string;
  domain?: string;
  tags?: string[];
}) {
  return keapApi('POST', '/captures', input);
}

export async function saveObject(input: {
  title: string;
  description?: string;
  type?: string;
  resource?: string;
  tags?: string[];
  body?: string;
}) {
  return keapApi('POST', '/objects', {
    type: input.type ?? 'note',
    ...input,
  });
}

export async function listTaxonomy() {
  return keapApi('GET', '/taxonomy/tree');
}

export async function proposeTaxonomyNode(input: {
  parentId?: string;
  name: string;
  description?: string;
  rationale?: string;
}) {
  return keapApi('POST', '/taxonomy/proposals/node', {
    parentId: input.parentId,
    name: input.name,
    description: input.description,
    rationale: input.rationale,
  });
}

export async function createDraft(kind: 'object' | 'capture' | 'taxonomy-node', payload: Record<string, unknown>) {
  return keapApi('POST', '/drafts', { kind, payload });
}
