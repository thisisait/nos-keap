/**
 * Header-OIDC identity — the idiomatic nOS SSO integration for an app we own.
 *
 * nOS fronts every service with a Traefik + Authentik forward-auth outpost.
 * When KEAP is declared with `mode: header_oidc`, the outpost injects these
 * trusted headers on every request that reached the app (the request already
 * passed the SSO gate) — exact set per nOS
 * roles/pazny.traefik/templates/dynamic/middlewares.yml.j2:
 *
 *   X-Authentik-Uid        stable per-user key (PREFERRED identity key)
 *   X-Authentik-Username   e.g. "alice"
 *   X-Authentik-Email      e.g. "alice@dev.local"
 *   X-Authentik-Name       display name
 *   X-Authentik-Groups     comma-separated RBAC groups (nos-admins, ...)
 *
 * SECURITY MODEL (two layers, both required):
 *  1. The container joins the Traefik-only `gated_net` and publishes its port
 *     on 127.0.0.1 only — containers cannot reach it (nOS SEC-02 + the A19
 *     note in services.yml.j2: Docker-published loopback ports are not
 *     reachable via host-gateway), and the LAN cannot reach it.
 *  2. The loopback port IS reachable by host processes (that is deliberate —
 *     AgentKit agents use it for /agent/v1 with a bearer token). Host
 *     processes do NOT carry Authentik headers, so in production the human
 *     /api surface must treat missing headers as 401 — NEVER as a fallback
 *     identity. The nOS role sets KEAP_TRUSTED_PROXY=1 to enforce this; the
 *     single-tenant dev fallback only exists when that flag is absent
 *     (local `npm run dev` / tests).
 */
import type { Request, Response, NextFunction } from 'express';

export interface KeapUser {
  id: string; // stable per-user key (X-Authentik-Uid) scoping all user rows
  username: string;
  email: string | null;
  name: string | null;
  groups: string[];
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: KeapUser;
    }
  }
}

const TRUSTED_PROXY = process.env.KEAP_TRUSTED_PROXY === '1';
const ADMIN_GROUPS = new Set(['nos-admins', 'nos-providers']);
const LOCAL_DEV_USER: KeapUser = {
  id: 'local',
  username: 'local',
  email: null,
  name: 'Local Dev',
  groups: ['nos-admins'],
  isAdmin: true,
};

export function identityMiddleware(req: Request, res: Response, next: NextFunction) {
  const username = header(req, 'x-authentik-username');
  if (!username) {
    if (TRUSTED_PROXY) {
      // Production (behind the outpost): a request without identity headers
      // did not come through Traefik — reject, do not impersonate anyone.
      return res
        .status(401)
        .json({ success: false, error: 'unauthenticated: missing forward-auth identity' });
    }
    // Local dev / test only (no outpost in front of us).
    req.user = LOCAL_DEV_USER;
    return next();
  }
  const groups = (header(req, 'x-authentik-groups') ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  req.user = {
    // Uid is the stable Authentik key; username is a fallback for older outposts.
    id: header(req, 'x-authentik-uid') ?? username,
    username,
    email: header(req, 'x-authentik-email'),
    name: header(req, 'x-authentik-name'),
    groups,
    isAdmin: groups.some((g) => ADMIN_GROUPS.has(g)),
  };
  next();
}

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
