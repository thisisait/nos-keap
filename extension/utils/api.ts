import { browser } from 'wxt/browser';

type MessageResponse = {
  success?: boolean;
  error?: string;
  data?: unknown;
};

export async function sendMessage<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = (await browser.runtime.sendMessage({ type, ...payload })) as MessageResponse | undefined;
  if (!response || !response.success) {
    throw new Error(response?.error ?? 'KEAP extension request failed');
  }
  return response.data as T;
}

export async function sendGetState() {
  return sendMessage<import('./storage').ExtensionState>('GET_STATE');
}

export async function sendSetState(state: Partial<import('./storage').ExtensionState>) {
  return sendMessage<import('./storage').ExtensionState>('SET_STATE', { state });
}

export async function sendClearState() {
  return sendMessage<null>('CLEAR_STATE');
}

export async function sendStartPairing(instanceUrl: string, clientName = 'KEAP Companion') {
  return sendMessage<{
    pairingId: string;
    userCode: string;
    verificationPath: string;
    expiresAt: number;
    intervalSeconds: number;
    deviceSecret: string;
    instanceUrl: string;
  }>('PAIRING_START', { instanceUrl, clientName });
}

export async function sendCheckPairing(instanceUrl: string, pairingId: string, deviceSecret: string) {
  return sendMessage<{
    token: string;
    credentialId: string;
    expiresAt: number;
    scopes: string[];
  }>('PAIRING_CHECK', { instanceUrl, pairingId, deviceSecret });
}

export async function sendCallApi(method: string, path: string, body?: unknown) {
  return sendMessage('API', { method, path, body });
}

export async function sendOpenTab(url: string) {
  return sendMessage<null>('OPEN_TAB', { url });
}
