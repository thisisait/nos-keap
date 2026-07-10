/**
 * Seed taxonomy access for the backend.
 *
 * The 12-domain / 790-node tree lives in src/game/data/taxonomy.ts (the repo's
 * core asset) and is compiled into the server build via tsconfig.server.json.
 * generateTaxonomyOptions() is ported verbatim from the old apiServer.ts — it
 * flattens the two top levels into <select> options for the Admin CMS.
 */
import { taxonomyData } from '../src/game/data/taxonomy';

export interface TaxonomyOption {
  value: string;
  label: string;
  level: number;
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
