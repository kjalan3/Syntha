import { describe, it, expect } from 'vitest';
import { buildMfrSection } from '@/lib/tools/mfr-builder';

describe('buildMfrSection', () => {
  it('returns the section name and non-empty content', () => {
    const r = buildMfrSection('identification', { formulaId: 'SYN-2026-001', drug: 'ketoprofen', strength: '5%', form: 'gel' });
    expect(r.section).toBe('identification');
    expect(r.content).toContain('SYN-2026-001');
    expect(r.content).toContain('ketoprofen');
  });

  it('renders an ingredients table', () => {
    const r = buildMfrSection('ingredients', {
      ingredients: [{ name: 'Ketoprofen USP', quantity_g: 5, role: 'active' }],
    });
    expect(r.section).toBe('ingredients');
    expect(r.content).toContain('Ketoprofen USP');
    expect(r.content).toContain('5');
  });

  it('renders a bud section with citation', () => {
    const r = buildMfrSection('bud', { bud_days: 14, storage: 'Refrigerated', citation: 'USP <795> Table 1' });
    expect(r.content).toContain('14');
    expect(r.content).toContain('USP <795> Table 1');
  });
});
