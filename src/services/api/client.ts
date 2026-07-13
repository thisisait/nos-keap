/**
 * Single typed fetch wrapper for the KEAP API.
 *
 * The backend wraps every response in { success, data, error }. The old
 * clients returned the raw envelope while their types claimed the payload —
 * every consumer was silently reading undefined fields. This unwraps the
 * envelope once, throws real errors, and keeps the per-domain client files
 * as thin typed facades.
 */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function apiFetch<T = void>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`API ${path}: invalid response (${response.status})`);
  }
  if (!response.ok || !envelope.success) {
    throw new Error(envelope.error ?? `API ${path} failed (${response.status})`);
  }
  return envelope.data as T;
}
