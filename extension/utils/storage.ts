import { browser } from 'wxt/browser';

const STORAGE_KEY = 'keap-state-v1';

export interface PendingPairing {
  pairingId: string;
  deviceSecret: string;
  userCode: string;
  verificationPath: string;
  intervalSeconds: number;
  instanceUrl: string;
  expiresAt: number;
}

export interface ExtensionUser {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
  clientName?: string;
  scopes?: string[];
}

export interface ExtensionState {
  instanceUrl: string;
  token: string | null;
  credentialId: string | null;
  user: ExtensionUser | null;
  scopes: string[];
  pairedAt: number | null;
  expiresAt: number | null;
  pendingPairing: PendingPairing | null;
}

export const defaultState: ExtensionState = {
  instanceUrl: 'http://localhost:8080',
  token: null,
  credentialId: null,
  user: null,
  scopes: [],
  pairedAt: null,
  expiresAt: null,
  pendingPairing: null,
};

export async function getState(): Promise<ExtensionState> {
  const { [STORAGE_KEY]: stored } = await browser.storage.local.get(STORAGE_KEY);
  const storedState = (stored as Partial<ExtensionState> | undefined) ?? {};
  const merged = { ...defaultState, ...storedState };
  return merged as ExtensionState;
}

export async function setState(partial: Partial<ExtensionState>): Promise<ExtensionState> {
  const existing = await getState();
  const next = { ...existing, ...partial };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function clearState(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}
