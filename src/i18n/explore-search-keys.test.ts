/**
 * The explore search dropdown's error/no-vectors notes reference these keys
 * at runtime via t() — a deleted key ships silently as the raw key string.
 * The 'vectors not synced' operator hint was ALREADY deleted once (the
 * SidePanel cull) while the condition it explains still occurs; this pins
 * both keys in both locales so that can't happen again.
 */
import { describe, it, expect } from 'vitest';
import en from './locales/en.json';
import cs from './locales/cs.json';

describe('explore search i18n keys', () => {
  for (const [name, dict] of [['en', en], ['cs', cs]] as const) {
    it(`${name} carries the search error + noVectors notes`, () => {
      expect(dict.explore.jump.error).toBeTruthy();
      expect(dict.explore.panel.noVectors).toContain('keap-embed-sync');
    });
  }
});
