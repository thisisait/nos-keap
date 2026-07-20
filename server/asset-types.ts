/**
 * Canonical "asset type → celestial form" map — the single source of truth for
 * how a data-piece is rendered in the /explore cosmology.
 *
 * A taxonomy node is a STAR; the data-pieces anchored to it (knowledge objects,
 * captures, resolved content links) orbit that star as typed bodies. The FORM is
 * chosen by the piece's data type, unifying the three type vocabularies that
 * exist today:
 *   - `object.type`          — open enum (objects.ts: note/page/query/table/
 *                              database/file/lake/…).
 *   - `ContentType`          — the dataType facet behind a `resource`/`requiredData`
 *                              ref (content-links.ts: encyclopedia/files/media/…).
 *   - capture modality       — `inferCaptureType` (→ a ContentType or 'capture').
 *
 * The mapping is pure and derived at API/render time — NO schema, NO layout
 * re-bake. The server ships `assetType`/`form`/`glyph`/`hue` per piece so the
 * client never re-derives it.
 */

/** The celestial body a data-piece renders as. */
export type CelestialForm = 'planet' | 'moon' | 'asteroid' | 'comet' | 'station';

/**
 * Canonical asset type. Covers the NEW rich-media/store kinds
 * (audio/video/image/database/dataTable/repo/fileshare) PLUS every existing
 * `ContentType` value and the common `object.type` strings. Unknown strings
 * normalize to `generic`.
 */
export type AssetType =
  // structured data
  | 'database' | 'dataTable' | 'query'
  // stores
  | 'repo' | 'fileshare' | 'file'
  // reference corpora
  | 'encyclopedia' | 'books' | 'wiki'
  // documents
  | 'notes' | 'page' | 'blog'
  // rich media
  | 'media' | 'video' | 'audio' | 'image'
  // interactive services
  | 'ai' | 'maps'
  // callable actions (the skill router's unit — one card per action)
  | 'skill'
  // feeds / captures
  | 'rss' | 'capture'
  | 'generic';

export interface AssetDescriptor {
  form: CelestialForm;
  glyph: string;
  /** base hue (0-360) for the body's material. */
  hue: number;
}

/**
 * Form metaphor:
 *   planet   — a massive primary dataset (a whole DB, a media library, a book set)
 *   moon     — a small document orbiting close (a note, a page, an image)
 *   asteroid — a tabular / transient chunk (a data table, an audio clip, a capture)
 *   comet    — a streaming feed with a tail (an RSS source)
 *   station  — an interactive / computed service (an AI chat, a query, a repo, a map)
 */
export const ASSET_FORM: Record<AssetType, AssetDescriptor> = {
  database: { form: 'planet', glyph: 'db', hue: 210 },
  fileshare: { form: 'planet', glyph: 'drive', hue: 190 },
  encyclopedia: { form: 'planet', glyph: 'globe', hue: 150 },
  books: { form: 'planet', glyph: 'book', hue: 40 },
  video: { form: 'planet', glyph: 'film', hue: 320 },
  media: { form: 'planet', glyph: 'media', hue: 300 },

  notes: { form: 'moon', glyph: 'note', hue: 265 },
  page: { form: 'moon', glyph: 'doc', hue: 220 },
  wiki: { form: 'moon', glyph: 'wiki', hue: 170 },
  blog: { form: 'moon', glyph: 'quote', hue: 20 },
  image: { form: 'moon', glyph: 'image', hue: 290 },
  file: { form: 'moon', glyph: 'file', hue: 200 },

  skill: { form: 'station', glyph: 'skill', hue: 95 },
  dataTable: { form: 'asteroid', glyph: 'table', hue: 180 },
  audio: { form: 'asteroid', glyph: 'wave', hue: 130 },
  capture: { form: 'asteroid', glyph: 'capture', hue: 45 },

  rss: { form: 'comet', glyph: 'rss', hue: 30 },

  ai: { form: 'station', glyph: 'ai', hue: 260 },
  query: { form: 'station', glyph: 'query', hue: 200 },
  repo: { form: 'station', glyph: 'git', hue: 100 },
  maps: { form: 'station', glyph: 'map', hue: 140 },

  generic: { form: 'asteroid', glyph: 'dot', hue: 210 },
};

/**
 * Raw type string (object.type OR ContentType OR capture modality) → canonical.
 * ContentType values that already match the union pass through untouched; the
 * rest are the common `object.type` spellings.
 */
const ALIAS: Record<string, AssetType> = {
  // object.type spellings
  note: 'notes',
  page: 'page',
  query: 'query',
  table: 'dataTable',
  datatable: 'dataTable',
  database: 'database',
  db: 'database',
  file: 'file',
  lake: 'fileshare',
  repo: 'repo',
  repository: 'repo',
  git: 'repo',
  document: 'page',
  howto: 'notes',
  recipe: 'notes',
  contact: 'generic',
  // ContentType spellings
  files: 'fileshare',
  encyclopedia: 'encyclopedia',
  media: 'media',
  books: 'books',
  ai: 'ai',
  rss: 'rss',
  wiki: 'wiki',
  notes: 'notes',
  maps: 'maps',
  blog: 'blog',
  capture: 'capture',
  // rich media
  audio: 'audio',
  sound: 'audio',
  video: 'video',
  image: 'image',
  img: 'image',
  photo: 'image',
  fileshare: 'fileshare',
};

export function normalizeAssetType(raw?: string): AssetType {
  if (!raw) return 'generic';
  const key = raw.trim().toLowerCase();
  if (key in ALIAS) return ALIAS[key];
  return key in ASSET_FORM ? (key as AssetType) : 'generic';
}

export function assetDescriptor(raw?: string): AssetDescriptor & { assetType: AssetType } {
  const assetType = normalizeAssetType(raw);
  return { assetType, ...ASSET_FORM[assetType] };
}
