import { describe, it, expect } from 'vitest';
import { lookupStability, getRegulatoryRules } from '@/lib/tools/stability-db';

describe('lookupStability', () => {
  it('finds a known ingredient (case-insensitive)', () => {
    const e = lookupStability('Ketoprofen');
    expect(e?.stability_range_days).toBe(90);
  });
  it('returns null for an unknown ingredient', () => {
    expect(lookupStability('unobtainium')).toBeNull();
  });
});

describe('getRegulatoryRules (fail-open rationale)', () => {
  it('returns a non-empty rationale string even with no cache', () => {
    const r = getRegulatoryRules({ cachePath: '/nonexistent/path.json' });
    expect(typeof r.rationale_text).toBe('string');
    expect(r.rationale_text.length).toBeGreaterThan(0);
    expect(r.source).toMatch(/bundled|USP/i);
  });
});
