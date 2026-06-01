import { describe, it, expect } from 'vitest';
import { runSignoff } from '@/lib/agents/reviewer';
import type { Prescription } from '@/lib/types';

const ketoprofen: Prescription = {
  drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5,
};
const hydrocortisone: Prescription = {
  drug: 'hydrocortisone', strength_pct: 1, dosage_form: 'cream', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 1.0,
};

describe('runSignoff', () => {
  it('ketoprofen 10x underdose → FAILED with stated_vs_prescribed', () => {
    const r = runSignoff(ketoprofen, { computedPct: '0.5000', statedPct: '0.5' });
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.invariant === 'stated_vs_prescribed')).toBe(true);
  });

  it('hydrocortisone clean → PASSED', () => {
    const r = runSignoff(hydrocortisone, {
      computedPct: '1.0000',
      statedPct: '1.0',
      now: new Date('2026-05-31T12:00:00Z').getTime(),
      demoOffline: true,
    });
    expect(r.passed).toBe(true);
    expect(r.findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  it('re-runs compliance and adds an error finding if ineligible at review time', () => {
    const r = runSignoff(
      { ...hydrocortisone, drug: 'estriol' },
      { computedPct: '1.0000', statedPct: '1.0', now: new Date('2026-05-31T12:00:00Z').getTime(), demoOffline: true },
    );
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.field.toLowerCase().includes('compliance'))).toBe(true);
  });
});
