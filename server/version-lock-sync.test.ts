import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The release version lives in TWO files, and npm 10 (the node:22 image's
 * npm) fails `npm ci` when they disagree — which is exactly how the v1.43.0
 * image build died: the release commit edited package.json by hand and left
 * package-lock.json's root version behind. npm 11 tolerates it locally, so
 * nothing red appeared before the tag. Bump releases with `npm version
 * X.Y.Z --no-git-tag-version` (it syncs both); this test is the tripwire.
 */
const read = (f: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'));

describe('package.json and package-lock.json agree', () => {
  it('root versions match (npm ci in the image build fails otherwise)', () => {
    const pkg = read('../package.json');
    const lock = read('../package-lock.json');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});
