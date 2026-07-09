/**
 * Header-OIDC identity — the idiomatic nOS SSO integration for an app we own.
 *
 * nOS fronts every service with a Traefik + Authentik forward-auth outpost.
 * When KEAP is declared with `mode: header_oidc` (or `auth: proxy` in a Tier-2
 * manifest), the outpost injects these trusted headers on every request that
 * reached the app (the request already passed the SSO gate):
 *
 *   X-Authentik-Username   e.g. "alice"
 *   X-Authentik-Email      e.g. "alice@dev.local"
 *   X-Authentik-Name       display name
 *   X-Authentik-Groups     comma-separated RBAC groups (nos-admins, ...)
 *
 * SECURITY: these headers are only trustworthy because Traefik is the sole
 * ingress and strips any client-supplied copies before forwarding. Never
 * expose this container's port on 0.0.0.0 — bind 127.0.0.1 and let Traefik
 * reach it (see deploy/nos/keap.yml). Outside nOS (local dev) there is no
 * outpost, so we fall back to a single "local" identity.
 */
import type { Request, Response, NextFunction } from 'express';

export interface KeapUser {
  id: string; // stable per-user key used to scope all progress rows
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

const ADMIN_GROUPS = new Set(['nos-admins', 'nos-providers']);
const LOCAL_DEV_USER: KeapUser = {
  id: 'local',
  username: 'local',
  email: null,
  name: 'Local Dev',
  groups: ['nos-admins'],
  isAdmin: true,
};

export function identityMiddleware(req: Request, _res: Response, next: NextFunction) {
  const username = header(req, 'x-authentik-username');
  if (!username) {
    // No outpost in front of us (local dev / test). Single-tenant fallback.
    req.user = LOCAL_DEV_USER;
    return next();
  }
  const groups = (header(req, 'x-authentik-groups') ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  req.user = {
    id: username,
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
