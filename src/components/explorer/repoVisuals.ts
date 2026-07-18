/**
 * Repo rendering assets — language detection, GitHub-linguist colours and the
 * procedural sphere texture for repo folder hubs in the files core.
 *
 * A repo sphere reads like "gravatar × GH language bar": longitude bands
 * proportional to the repo's language byte-mix (colours below), rotated by a
 * name-seeded offset, with a mirrored identicon speckle overlay seeded by the
 * same name — every repo gets a stable, unique face. The server ships raw
 * extension byte-buckets (fsDirs.exts); everything language-ish happens here.
 */
import * as THREE from 'three';

/** GitHub-linguist colours for the common languages (fallback = hashed hue). */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#663399',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Dart: '#00B4AB',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  R: '#198CE7',
  Julia: '#a270ba',
  Zig: '#ec915c',
  HCL: '#844FBA',
  SQL: '#e38c00',
};

/** ext → language. Anything absent (md, json, yaml, images, locks) is docs/data
 *  and stays OUT of the "primary languages" mix — linguist's bar does the same. */
const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java',
  kt: 'Kotlin', kts: 'Kotlin',
  c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS',
  vue: 'Vue', svelte: 'Svelte', dart: 'Dart',
  ex: 'Elixir', exs: 'Elixir', hs: 'Haskell', lua: 'Lua',
  r: 'R', jl: 'Julia', zig: 'Zig', tf: 'HCL', hcl: 'HCL', sql: 'SQL',
};

/** FNV-ish 0..1 string hash — deterministic seeds for textures and orbits. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function fallbackColor(lang: string): string {
  return `hsl(${Math.round(hash01(lang) * 360)}, 55%, 55%)`;
}

export function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? fallbackColor(lang);
}

/** Language of a file path by extension — undefined for docs/data/unknown. */
export function langOfPath(p: string): string | undefined {
  const i = p.lastIndexOf('.');
  return i === -1 ? undefined : EXT_LANG[p.slice(i + 1).toLowerCase()];
}

export interface RepoLang {
  lang: string;
  bytes: number;
  pct: number;
  color: string;
}

/** Merge server ext buckets into a top-6 language mix (linguist-bar style). */
export function repoLangs(exts: Array<[string, number]>): RepoLang[] {
  const by = new Map<string, number>();
  for (const [ext, b] of exts) {
    const lang = EXT_LANG[ext];
    if (lang) by.set(lang, (by.get(lang) ?? 0) + b);
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang, bytes]) => ({ lang, bytes, pct: bytes / total, color: langColor(lang) }));
}

/** "1.2 MB"-style humanized byte count for panels. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Texture cache — nodeThreeObject re-runs on every graph rebuild; the canvas
// work must happen once per (name, mix), not once per render.
const texCache = new Map<string, THREE.CanvasTexture>();

/**
 * 256×128 equirectangular face: language longitude-bands (name-seeded start
 * rotation) under a 4×8 mirrored identicon speckle. Deterministic by inputs.
 */
export function repoTexture(name: string, langs: RepoLang[]): THREE.CanvasTexture {
  const key = `${name}|${langs.map((l) => `${l.lang}:${l.pct.toFixed(2)}`).join(',')}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a2233'; // base for language-less repos
  g.fillRect(0, 0, W, H);
  // Longitude bands, wrapped at the seam; start offset = the "original
  // layout by name" — two repos with the same mix still look different.
  let x = hash01(name) * W;
  for (const l of langs) {
    const w = l.pct * W;
    g.fillStyle = l.color;
    const x0 = x % W;
    g.fillRect(x0, 0, Math.min(w, W - x0), H);
    if (x0 + w > W) g.fillRect(0, 0, x0 + w - W, H); // wrap-around remainder
    x += w;
  }
  // Identicon speckle: mirrored 4×8 grid, seeded by name — light/dark cells
  // give the unique "gravatar" fingerprint over the language bands.
  const cw = W / 8;
  const ch = H / 4;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const v = hash01(`${name}:${row}:${col}`);
      if (v < 0.3) g.fillStyle = 'rgba(255,255,255,0.16)';
      else if (v > 0.72) g.fillStyle = 'rgba(0,0,0,0.28)';
      else continue;
      g.fillRect(col * cw, row * ch, cw, ch);
      g.fillRect((7 - col) * cw, row * ch, cw, ch); // horizontal mirror
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  texCache.set(key, tex);
  return tex;
}
