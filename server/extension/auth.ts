import type { NextFunction, Request, Response } from 'express';
import { bearerOf } from '../tokens';
import type { ExtensionScope } from '../../shared/contracts/extension';
import { authenticateCredential, type ExtensionIdentity } from './store';

declare module 'express-serve-static-core' {
  interface Request {
    extensionIdentity?: ExtensionIdentity;
  }
}

export function extensionAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearerOf(req.headers.authorization);
  const identity = token ? authenticateCredential(token) : null;
  if (!identity) return res.status(401).json({ success: false, error: 'invalid or expired extension credential' });
  req.extensionIdentity = identity;
  next();
}

export function requireExtensionScope(scope: ExtensionScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.extensionIdentity?.scopes.includes(scope)) {
      return res.status(403).json({ success: false, error: `extension scope required: ${scope}` });
    }
    next();
  };
}
