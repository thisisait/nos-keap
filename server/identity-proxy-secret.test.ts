/**
 * The proxy shared secret is what makes the X-Authentik-* headers trustworthy:
 * without it, any host process on the loopback port forges an admin. These
 * tests pin the door order — the secret is checked BEFORE any identity header
 * is read — and the staged-rollout contract (unset env = today's behavior).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { identityMiddleware } from './identity';

function call(headers: Record<string, string>) {
  const req = { headers } as unknown as Request;
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  let nexted = false;
  identityMiddleware(req, res, () => {
    nexted = true;
  });
  return { statusCode, nexted, req };
}

const ADMIN_HEADERS = {
  'x-authentik-username': 'mallory',
  'x-authentik-groups': 'nos-admins',
};

describe('KEAP_PROXY_SHARED_SECRET', () => {
  afterEach(() => {
    delete process.env.KEAP_PROXY_SHARED_SECRET;
  });

  it('rejects forged identity headers that lack the proxy secret', () => {
    process.env.KEAP_PROXY_SHARED_SECRET = 's3cret';
    const { statusCode, nexted } = call(ADMIN_HEADERS);
    expect(statusCode).toBe(401);
    expect(nexted).toBe(false);
  });

  it('rejects a wrong secret', () => {
    process.env.KEAP_PROXY_SHARED_SECRET = 's3cret';
    const { statusCode, nexted } = call({ ...ADMIN_HEADERS, 'x-keap-proxy-secret': 'nope' });
    expect(statusCode).toBe(401);
    expect(nexted).toBe(false);
  });

  it('admits the proxy and then builds identity from the headers', () => {
    process.env.KEAP_PROXY_SHARED_SECRET = 's3cret';
    const { nexted, req } = call({ ...ADMIN_HEADERS, 'x-keap-proxy-secret': 's3cret' });
    expect(nexted).toBe(true);
    expect(req.user.username).toBe('mallory');
    expect(req.user.isAdmin).toBe(true);
  });

  it('unset env keeps current behavior (staged rollout)', () => {
    const { nexted, req } = call(ADMIN_HEADERS);
    expect(nexted).toBe(true);
    expect(req.user.username).toBe('mallory');
  });
});
