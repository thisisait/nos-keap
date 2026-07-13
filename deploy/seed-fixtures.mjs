#!/usr/bin/env node
/**
 * Fixture seed — offers a fresh nOS install a few illustrative data tables so
 * the TableStore (Track R2′) shows real, OLAP-shaped content instead of an
 * empty grid. Explicitly OPT-IN and idempotent: KEAP's own doctrine is
 * "empty state is real state" (no auto-seeded fake data), so this runs only
 * when the operator enables `keap_seed_fixtures`, and each fixture is created
 * only if its (fixed) id is absent — deleting one and re-running never dupes.
 *
 * Runs against the loopback API with a dedicated system identity
 * (`nos-fixtures`, tier-1) so the tables have a stable owner. Each fixture
 * carries a distinct share scope to also demonstrate the RBAC tiers:
 *   - Reading Log     → shared        (everyone in the tenant)
 *   - Field Log       → tier-users    (users, managers, admins)
 *   - Home Inventory  → private       (owner + admins)
 *
 * Usage: node deploy/seed-fixtures.mjs   (env KEAP_SEED_URL, default :8080)
 */
const BASE = (process.env.KEAP_SEED_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const HEADERS = {
  'content-type': 'application/json',
  'x-authentik-uid': 'nos-fixtures',
  'x-authentik-username': 'nos-fixtures',
  'x-authentik-name': 'nOS Fixtures',
  'x-authentik-groups': 'nos-admins',
};

// Fixed ids → idempotency: a fixture is (re)created only when absent.
const FIXTURES = [
  {
    id: 'f1000000-0000-4000-8000-000000000001',
    title: 'Reading Log',
    description: 'Books to read and read — a demo of dimensions (status, subject) over measures (pages, rating).',
    anchors: ['05'], // Humanities
    visibility: 'shared',
    schema: {
      columns: [
        { key: 'title', label: 'Title', kind: 'text', role: 'attribute', required: true },
        { key: 'author', label: 'Author', kind: 'text', role: 'attribute' },
        { key: 'status', label: 'Status', kind: 'select', role: 'dimension', options: ['to-read', 'reading', 'done'] },
        { key: 'subject', label: 'Subject', kind: 'taxonomyRef', role: 'dimension' },
        { key: 'pages', label: 'Pages', kind: 'number', role: 'measure' },
        { key: 'rating', label: 'Rating', kind: 'number', role: 'measure', unit: '/5' },
      ],
    },
    rows: [
      { title: 'The Structure of Scientific Revolutions', author: 'Thomas Kuhn', status: 'done', subject: '05', pages: 264, rating: 5 },
      { title: 'Gödel, Escher, Bach', author: 'Douglas Hofstadter', status: 'reading', subject: '02', pages: 777, rating: 5 },
      { title: 'Sapiens', author: 'Yuval Noah Harari', status: 'to-read', subject: '05.01', pages: 443, rating: 4 },
    ],
  },
  {
    id: 'f1000000-0000-4000-8000-000000000002',
    title: 'Field Log',
    description: 'Field observations — slice by site/species, aggregate count and temperature.',
    anchors: ['01.03'], // Biology
    visibility: 'tier-users',
    schema: {
      columns: [
        { key: 'site', label: 'Site', kind: 'select', role: 'dimension', options: ['meadow', 'riverbank', 'forest'] },
        { key: 'species', label: 'Species', kind: 'text', role: 'attribute', required: true },
        { key: 'observed_on', label: 'Observed', kind: 'date', role: 'dimension' },
        { key: 'count', label: 'Count', kind: 'number', role: 'measure' },
        { key: 'temp_c', label: 'Temp', kind: 'number', role: 'measure', unit: '°C' },
      ],
    },
    rows: [
      { site: 'meadow', species: 'Apis mellifera', observed_on: 1_717_200_000, count: 14, temp_c: 22 },
      { site: 'riverbank', species: 'Ardea cinerea', observed_on: 1_717_286_400, count: 2, temp_c: 18 },
      { site: 'forest', species: 'Cervus elaphus', observed_on: 1_717_372_800, count: 5, temp_c: 15 },
    ],
  },
  {
    id: 'f1000000-0000-4000-8000-000000000003',
    title: 'Home Inventory',
    description: 'A private list — quantity and value rolled up by room and category.',
    anchors: ['03'], // Applied Sciences & Technology
    visibility: 'private',
    schema: {
      columns: [
        { key: 'item', label: 'Item', kind: 'text', role: 'attribute', required: true },
        { key: 'room', label: 'Room', kind: 'select', role: 'dimension', options: ['office', 'kitchen', 'garage'] },
        { key: 'category', label: 'Category', kind: 'select', role: 'dimension', options: ['electronics', 'tools', 'appliance'] },
        { key: 'quantity', label: 'Qty', kind: 'number', role: 'measure' },
        { key: 'value_czk', label: 'Value', kind: 'number', role: 'measure', unit: 'CZK' },
      ],
    },
    rows: [
      { item: 'Mac Studio', room: 'office', category: 'electronics', quantity: 1, value_czk: 62000 },
      { item: 'Cordless drill', room: 'garage', category: 'tools', quantity: 2, value_czk: 3200 },
      { item: 'Espresso machine', room: 'kitchen', category: 'appliance', quantity: 1, value_czk: 14500 },
    ],
  },
];

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  // Health gate — the loopback API must be up (identity middleware + DB).
  const health = await api('GET', '/api/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`seed-fixtures: KEAP not ready at ${BASE} (health ${health.status})`);
    process.exit(1);
  }
  let created = 0;
  let skipped = 0;
  for (const f of FIXTURES) {
    const existing = await api('GET', `/api/tables/${f.id}`);
    if (existing.status === 200) {
      skipped++;
      console.log(`seed-fixtures: '${f.title}' already present — skipping`);
      continue;
    }
    const { rows, ...req } = f;
    const mk = await api('POST', '/api/tables', { ...req, driver: 'libsql' });
    if (mk.status !== 200 || !mk.json?.success) {
      console.error(`seed-fixtures: create '${f.title}' failed:`, mk.json?.error ?? mk.status);
      process.exit(1);
    }
    for (const values of rows) {
      const rr = await api('POST', `/api/tables/${f.id}/rows`, { values });
      if (rr.status !== 200 || !rr.json?.success) {
        console.error(`seed-fixtures: row insert into '${f.title}' failed:`, rr.json?.error ?? rr.status);
        process.exit(1);
      }
    }
    created++;
    console.log(`seed-fixtures: seeded '${f.title}' (${rows.length} rows, ${f.visibility})`);
  }
  console.log(`seed-fixtures: done — ${created} created, ${skipped} already present`);
}

main().catch((e) => {
  console.error('seed-fixtures: unexpected error:', e?.message ?? e);
  process.exit(1);
});
