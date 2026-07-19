/**
 * Orbital placement for typed data-pieces (ROADMAP Track U — cosmology).
 *
 * A taxonomy node is a STAR pinned to its baked U1 coordinate. The data-pieces
 * anchored to it (knowledge objects) orbit that star as typed bodies. Their
 * positions are a PURE FUNCTION of (star coord, index, form, id) computed at
 * merge time and PINNED (fx/fy/fz) — they never enter the force sim as dust, so
 * dragging the star never scatters them. No layout bake, no server state.
 */

export type CelestialForm = 'planet' | 'moon' | 'asteroid' | 'comet' | 'station';

/**
 * Rendered radius (node "val") per form — moons small, comets slim, planets big.
 * U2″ Phase B (B1): bumped ~1.7× over the original 1.2–2.6 so anchored bodies
 * read from the constellation OVERVIEW, not only after a click-warp. The
 * apparent-size LOD in GraphCanvas then culls them by distance, so bigger
 * bodies never flood the wide view — they just become visible sooner.
 */
export const FORM_SIZE: Record<CelestialForm, number> = {
  moon: 2.0,
  asteroid: 2.4,
  station: 3.0,
  planet: 4.4,
  comet: 2.7,
};

/**
 * Orbital clearance per form — how far the body sits from the star surface.
 * B1: widened ~1.6× so the (now larger) bodies clear the star glow and each
 * other, giving each star a legible little "solar system" instead of a clump.
 */
export const FORM_RADIUS: Record<CelestialForm, number> = {
  moon: 20,
  station: 32,
  asteroid: 36,
  planet: 48,
  comet: 68,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Cheap deterministic 0..1 from a string (FNV-1a) — no crypto in the browser. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Wrap body `i` of `n` around its star in 3D (a fibonacci direction so bodies
 * never line up), at a radius = the star's rendered clearance + the form's
 * orbit. Deterministic: same inputs → same point, so re-renders are stable.
 */
export function orbitalPosition(
  star: { x: number; y: number; z: number },
  i: number,
  n: number,
  form: CelestialForm,
  id: string,
  starSize: number,
): [number, number, number] {
  const clearance = Math.sqrt(Math.max(starSize, 1)) * 2.4;
  // B1 spacing: a busy star spreads its bodies over a BIGGER shell (crowd),
  // and each body gets a mild radial offset (jitter) so same-form bodies sit at
  // different depths instead of one thin, overlap-prone shell. Deterministic —
  // same (id, form, i, n) → same point, so re-renders stay byte-stable.
  const crowd = 1 + Math.min(0.8, n / 30);
  const jitter = 1 + (hash01(id + ':r') - 0.5) * 0.3;
  const R = (clearance + (FORM_RADIUS[form] ?? FORM_RADIUS.asteroid)) * crowd * jitter;
  const y = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const rr = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE + hash01(id) * 0.5;
  return [star.x + Math.cos(phi) * rr * R, star.y + y * R, star.z + Math.sin(phi) * rr * R];
}
