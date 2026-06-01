import { describe, it, expect } from 'vitest';
import { buildReferencePack } from '@/lib/agents/reference-pack';
import type { Prescription } from '@/lib/types';

const rx: Prescription = {
  drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5,
};

describe('buildReferencePack', () => {
  it('returns exactly the single matching formulary + stability entry', () => {
    const pack = buildReferencePack(rx, { now: new Date('2026-05-31T12:00:00Z').getTime(), demoOffline: true });
    expect(pack.formulary?.drug).toBe('ketoprofen');
    expect(pack.stability?.ingredient).toBe('ketoprofen');
    expect(pack.bud_rationale.length).toBeGreaterThan(0);
    expect(pack.compliance.drug).toBe('ketoprofen');
  });

  it('null formulary/stability for an unknown drug, still returns compliance', () => {
    const pack = buildReferencePack(
      { ...rx, drug: 'unobtainium' },
      { now: Date.now(), demoOffline: true },
    );
    expect(pack.formulary).toBeNull();
    expect(pack.stability).toBeNull();
    expect(pack.compliance).toBeTruthy();
  });
});
