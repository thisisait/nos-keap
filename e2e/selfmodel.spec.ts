import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * The self-model chain, end to end, through the REAL channels:
 *
 *   canonical slug tree ──ingest (BEFORE boot, playbook order)──▶ taxonomy
 *   skill cards (files) ──fs-sync, shared uid nos-docs──────────▶ typed cards
 *   Requires: body line ──mechanical producer──▶ proposed `requires` relations
 *   moderation ──▶ verb-labelled edges in /api/graph + the brain endpoint
 *
 * The canonical fixture is applied by the webServer command before the server
 * starts (see playwright.config.ts), so boot-time registration of a slug
 * subtree — root placement, children-first created_at, layout fixpoint — is
 * what this suite runs on, not a runtime shortcut.
 */
test.describe.configure({ mode: 'serial' });

const RO = { Authorization: 'Bearer e2e-ro' };
// cwd-relative like every other spec — __dirname does not exist in ESM specs
// (the same trap build-version.ts hit inside the server bundle).
const REPO = path.resolve('.');
const SKILLS_SRC = path.join(REPO, 'e2e', 'fixtures', 'selfmodel-skills');
const SKILLS_DST = path.join(REPO, 'e2e', '.userfiles', 'nos-docs', 'nOS', 'skills');

test.describe('nOS self-model — taxonomy, cards, router relations', () => {
  test('the agent health surface declares the selfmodel contract version', async ({ request }) => {
    const h = (await (
      await request.get('/agent/v1/health', { headers: RO })
    ).json()) as { data: { contracts?: Record<string, number> } };
    // The nOS wet gate compares this against the contract it was built for —
    // the runtime says which contract it IMPLEMENTS, not which tag it wears.
    expect(h.data.contracts?.selfmodel).toBe(1);
  });

  test('the slug subtree registered at boot, root on its own ring', async ({ request }) => {
    const graph = (await (await request.get('/api/graph')).json()).data as {
      nodes: Array<{ id: string; name: string; level: number; parentId: string | null; x?: number; y?: number }>;
    };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    const root = byId.get('nos');
    expect(root, 'root registered from the pre-boot ingest').toBeTruthy();
    expect(root!.parentId).toBeNull();
    expect(root!.level).toBe(0);
    // Its OWN ring, outside the seed radius — not parked inside a seed domain.
    expect(Math.hypot(root!.x!, root!.y!)).toBeGreaterThan(1400 * 1.5);

    for (const id of ['nos.infra', 'nos.infra.postgresql', 'nos.infra.redis', 'nos.iiab', 'nos.iiab.nextcloud', 'nos.iiab.nextcloud.credential']) {
      const n = byId.get(id);
      expect(n, `${id} present`).toBeTruthy();
      expect(n!.x, `${id} has a position`).not.toBeUndefined();
    }
    // The credential hangs under its ISSUER, near it in space.
    const sys = byId.get('nos.iiab.nextcloud')!;
    const cred = byId.get('nos.iiab.nextcloud.credential')!;
    expect(Math.hypot(cred.x! - sys.x!, cred.y! - sys.y!)).toBeLessThan(600);
  });

  test('skill cards sync via the shared uid with typed identity and zero dangling anchors', async ({
    request,
  }) => {
    mkdirSync(SKILLS_DST, { recursive: true });
    for (const f of readdirSync(SKILLS_SRC)) copyFileSync(path.join(SKILLS_SRC, f), path.join(SKILLS_DST, f));

    const r = (await (
      await request.post('/agent/v1/fs/sync?wait=1', {
        headers: { Authorization: 'Bearer e2e-rw', 'Content-Type': 'application/json' },
        data: {},
      })
    ).json()) as { data: { upserted: number; danglingAnchors?: number } };
    expect(r.data.upserted).toBeGreaterThanOrEqual(3);
    // Nodes were ingested BEFORE boot, so nothing may dangle — this is the
    // contract's acceptance criterion for the producer's ordering fix.
    expect(r.data.danglingAnchors ?? 0).toBe(0);

    const graph = (await (await request.get('/api/graph')).json()).data as {
      objects: Array<{ id: string; title: string; type: string; form?: string; anchors: string[] }>;
    };
    const skills = graph.objects.filter((o) => o.type === 'skill');
    expect(skills.length).toBeGreaterThanOrEqual(3);

    const upload = skills.find((s) => s.title === 'upload-file');
    // Frontmatter decided identity: type from `type:`, title from `title:` —
    // NOT 'page' by extension, NOT 'upload-file.md' by basename.
    expect(upload, 'title comes from frontmatter, not basename').toBeTruthy();
    expect(upload!.form, 'skill renders as a station').toBe('station');
    expect(upload!.anchors).toContain('nos.iiab.nextcloud');
  });

  test('the mechanical producer turns Requires: lines into proposed `requires` relations', async () => {
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'skills-requires.mjs'), 'post'], {
      env: {
        ...process.env,
        KEAP_BASE_URL: 'http://localhost:18300',
        KEAP_AGENT_TOKEN_RO: 'e2e-ro',
        KEAP_AGENT_TOKEN_RW: 'e2e-rw',
      },
      encoding: 'utf8',
    });
    const result = JSON.parse(out.slice(out.indexOf('REQUIRES_RESULT') + 'REQUIRES_RESULT '.length));
    expect(result.withLine, 'two cards declare a precondition').toBe(2);
    expect(result.posted).toBe(2);
    expect(result.dangling).toEqual([]);
    expect(result.malformed).toEqual([]);
  });

  test('a dangling Requires target is reported and NEVER posted', async ({ request }) => {
    const mk = await request.post('/api/objects', {
      data: { id: 'skill-dangling-probe', type: 'skill', title: 'ghost-skill', body: 'Requires: nos.ghost.credential\n' },
    });
    expect(mk.ok()).toBeTruthy();
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'skills-requires.mjs'), 'post', '--dry-run'], {
      env: { ...process.env, KEAP_BASE_URL: 'http://localhost:18300', KEAP_AGENT_TOKEN_RO: 'e2e-ro' },
      encoding: 'utf8',
    });
    const result = JSON.parse(out.slice(out.indexOf('REQUIRES_RESULT') + 'REQUIRES_RESULT '.length));
    expect(result.dangling).toEqual([{ card: 'skill-dangling-probe', ref: 'nos.ghost.credential' }]);
    expect((await request.delete('/api/objects/skill-dangling-probe')).ok()).toBeTruthy();
  });

  test('a body truncated at the read cap fails the producer LOUDLY, never as "no precondition"', async ({
    request,
  }) => {
    // The read endpoint caps body at 8000 chars. A Requires: line past the cap
    // is invisible to the producer, and "no line found" must not be conflated
    // with "line never seen" — the card is reported and the exit code is red.
    const long = `${'filler line\n'.repeat(700)}Requires: nos.iiab.nextcloud.credential\n`;
    expect(long.length).toBeGreaterThan(8000);
    const mk = await request.post('/api/objects', {
      data: { id: 'skill-truncated-probe', type: 'skill', title: 'long-skill', body: long },
    });
    expect(mk.ok()).toBeTruthy();

    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync('node', [path.join(REPO, 'scripts', 'skills-requires.mjs'), 'post', '--dry-run'], {
        env: { ...process.env, KEAP_BASE_URL: 'http://localhost:18300', KEAP_AGENT_TOKEN_RO: 'e2e-ro' },
        encoding: 'utf8',
      });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      code = err.status;
      stdout = err.stdout;
    }
    expect(code, 'untrusted scan must exit non-zero').toBe(3);
    const result = JSON.parse(stdout.slice(stdout.indexOf('REQUIRES_RESULT') + 'REQUIRES_RESULT '.length));
    expect(result.truncated).toEqual(['skill-truncated-probe']);
    expect((await request.delete('/api/objects/skill-truncated-probe')).ok()).toBeTruthy();
  });

  test('moderation confirms → verb-labelled edges reach the graph and the brain endpoint', async ({
    request,
  }) => {
    const admin = (await (await request.get('/api/admin/relations?status=proposed')).json()) as {
      data: { relations: Array<{ id: string; type: string }> };
    };
    const mine = admin.data.relations.filter((r) => r.type === 'requires');
    expect(mine.length).toBe(2);
    for (const rel of mine) {
      const d = await request.post(`/api/admin/relations/${rel.id}`, { data: { status: 'confirmed' } });
      expect(d.ok()).toBeTruthy();
    }

    const graph = (await (await request.get('/api/graph')).json()).data as {
      crossRelations?: Array<{ from: string; to: string; type: string; label: string }>;
    };
    const requires = (graph.crossRelations ?? []).filter((r) => r.type === 'requires');
    expect(requires.length).toBe(2);
    expect(requires.every((r) => r.to === 'nos.iiab.nextcloud.credential')).toBe(true);
    expect(requires[0].label).toBe('requires'); // seeded verb, registry label

    const brain = (await (
      await request.get('/agent/v1/graph', { headers: RO })
    ).json()) as { data: { edges: Array<{ type: string }> } };
    expect(brain.data.edges.filter((e) => e.type === 'requires').length).toBe(2);
  });

  test('the skill facet exists in the explore panel and filters the scene', async ({
    page,
    request,
  }) => {
    // One NON-skill card, or the facet has nothing to narrow: with a corpus of
    // skills only, selecting 'skill' keeps everything and the assertion is
    // vacuously un-meetable.
    const mk = await request.post('/api/objects', {
      data: { id: 'selfmodel-note-probe', type: 'note', title: 'redis runbook', body: 'anchored [[nos.infra.redis]]' },
    });
    expect(mk.ok()).toBeTruthy();

    await page.goto('/explore?core=fs');
    const canvas = page.getByTestId('explore-canvas');
    const objects = async () => Number(await canvas.getAttribute('data-object-count'));
    const facet = page.getByText('skill', { exact: true });
    await expect(facet).toBeVisible();
    const all = await objects();
    expect(all).toBeGreaterThanOrEqual(4); // 3 skills + the note
    await facet.click();
    await expect.poll(objects, { message: 'facet narrows the scene to skills' }).toBeLessThan(all);
    await facet.click();
    await expect.poll(objects).toBe(all);

    expect((await request.delete('/api/objects/selfmodel-note-probe')).ok()).toBeTruthy();
  });
});
