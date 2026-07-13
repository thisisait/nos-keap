import { z } from 'zod';

export const EXTENSION_PROTOCOL_VERSION = 1;

export const extensionScopeSchema = z.enum([
  'context:read',
  'capture:write',
  'objects:read',
  'objects:write',
  'types:read',
  'types:write',
  'taxonomy:read',
  'taxonomy:propose',
  'drafts:write',
]);

export type ExtensionScope = z.infer<typeof extensionScopeSchema>;

export const DEFAULT_EXTENSION_SCOPES: ExtensionScope[] = [
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

export const pairingStartSchema = z.object({
  clientName: z.string().trim().min(1).max(80),
  deviceSecret: z.string().min(32).max(128),
  scopes: z.array(extensionScopeSchema).min(1).max(DEFAULT_EXTENSION_SCOPES.length),
});

export const pairingExchangeSchema = z.object({
  pairingId: z.string().uuid(),
  deviceSecret: z.string().min(32).max(128),
});

export const contextInputSchema = z
  .object({
    url: z.string().url().max(4096),
    title: z.string().trim().min(1).max(300),
    selection: z.string().max(20_000).optional(),
    excerpt: z.string().max(100_000).optional(),
    description: z.string().max(2_000).optional(),
    lang: z.string().max(32).optional(),
  })
  .refine((value) => Boolean(value.selection?.trim() || value.excerpt?.trim() || value.title.trim()), {
    message: 'title, selection or excerpt is required',
  });

export const extensionObjectInputSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(2_000).optional(),
  resource: z.string().max(4096).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  body: z.string().max(500_000).optional(),
  visibility: z.enum(['private', 'shared']).default('private'),
});

export const extensionCaptureInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(300),
  text: z.string().max(100_000).optional(),
  url: z.string().url().max(4096).optional(),
  domain: z.string().max(255).optional(),
  capturedAt: z.number().int().positive().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const draftInputSchema = z.object({
  kind: z.enum(['object', 'capture', 'taxonomy-node', 'taxonomy-description', 'taxonomy-brief']),
  payload: z.record(z.string(), z.unknown()),
  ttlSeconds: z.number().int().min(300).max(172_800).default(86_400),
});

export interface ExtensionHealth {
  protocolVersion: number;
  instanceId: string;
  displayName: string;
  canonicalOrigin: string | null;
  capabilities: string[];
}
