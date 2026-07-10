/**
 * Seed taxonomy access for the backend.
 *
 * The 12-domain / 790-node tree lives in src/game/data/taxonomy.ts (the repo's
 * core asset) and is compiled into the server build via tsconfig.server.json.
 *
 * - generateTaxonomyOptions() is ported verbatim from the old apiServer.ts —
 *   it flattens the two top levels into <select> options for the Admin CMS.
 * - flattenTaxonomy() flattens the WHOLE tree (categories, subcategories at
 *   any depth, leaf items) for the agent surface: lookup by id, ancestors,
 *   children, and the FTS index.
 */
import { taxonomyData } from '../src/game/data/taxonomy';
import type { TaxonomyItem, TaxonomySubcategory } from '../src/game/types/taxonomy';

export interface TaxonomyOption {
  value: string;
  label: string;
  level: number;
}

export interface FlatNode {
  id: string;
  name: string;
  description?: string;
  kind: 'category' | 'subcategory' | 'item';
  parentId: string | null;
  /** Human-readable ancestry, e.g. "Natural Sciences > Physics > Kinematics" */
  path: string;
  requiredData?: string;
  questType?: string;
  childIds: string[];
}

export function generateTaxonomyOptions(): TaxonomyOption[] {
  const options: TaxonomyOption[] = [];
  let categoryIndex = 1;

  Object.values(taxonomyData).forEach((category: any) => {
    const categoryId = String(categoryIndex).padStart(2, '0');
    options.push({ value: categoryId, label: `${categoryId} - ${category.name}`, level: 0 });

    let subcategoryIndex = 1;
    if (category.subcategories) {
      Object.values(category.subcategories).forEach((subcat: any) => {
        const subcatId = `${categoryId}.${String(subcategoryIndex).padStart(2, '0')}`;
        options.push({ value: subcatId, label: `${subcatId} - ${subcat.name}`, level: 1 });
        subcategoryIndex++;
      });
    }

    categoryIndex++;
  });

  return options;
}

// ── Full flatten (built once at module load; the dataset is static) ───────────

const nodesById = new Map<string, FlatNode>();

function addNode(node: FlatNode) {
  nodesById.set(node.id, node);
  if (node.parentId) {
    const parent = nodesById.get(node.parentId);
    if (parent) parent.childIds.push(node.id);
  }
}

function walkSubcategory(sub: TaxonomySubcategory, parentId: string, parentPath: string) {
  const path = `${parentPath} > ${sub.name}`;
  addNode({
    id: sub.id,
    name: sub.name,
    description: sub.description,
    kind: 'subcategory',
    parentId,
    path: parentPath,
    childIds: [],
  });
  for (const child of Object.values(sub.subcategories ?? {})) {
    walkSubcategory(child, sub.id, path);
  }
  for (const item of sub.items ?? []) {
    addNode({
      id: item.id,
      name: item.name,
      description: item.description,
      kind: 'item',
      parentId: sub.id,
      path,
      requiredData: (item as TaxonomyItem).requiredData,
      questType: (item as TaxonomyItem).questType,
      childIds: [],
    });
  }
}

for (const category of Object.values(taxonomyData)) {
  addNode({
    id: category.id,
    name: category.name,
    description: category.description,
    kind: 'category',
    parentId: null,
    path: '',
    childIds: [],
  });
  for (const sub of Object.values(category.subcategories ?? {})) {
    walkSubcategory(sub, category.id, category.name);
  }
}

export function allNodes(): FlatNode[] {
  return [...nodesById.values()];
}

export function getNode(id: string): FlatNode | null {
  return nodesById.get(id) ?? null;
}

export function getAncestors(id: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  let cur = nodesById.get(id)?.parentId ?? null;
  while (cur) {
    const n = nodesById.get(cur);
    if (!n) break;
    out.unshift({ id: n.id, name: n.name });
    cur = n.parentId;
  }
  return out;
}

export function taxonomyNodeCount(): number {
  return nodesById.size;
}
