import { describe, it, expect } from 'vitest';
import { computeBud } from '@/lib/tools/bud-engine';

describe('computeBud', () => {
  it('aqueous nonpreserved → 14 days refrigerated', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream' });
    expect(r.bud_days).toBe(14);
    expect(r.rule_id).toBe('aq-nonpreserved');
    expect(r.storage).toMatch(/Refrigerated/i);
    expect(r.rule_citation).toContain('USP <795>');
  });

  it('aqueous preserved → 35 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: true, dosage_form: 'gel' });
    expect(r.bud_days).toBe(35);
    expect(r.rule_id).toBe('aq-preserved');
  });

  it('nonaqueous oral liquid → 90 days', () => {
    const r = computeBud({ aw_class: 'nonaqueous', preserved: false, oral: true, dosage_form: 'oral solution' });
    expect(r.bud_days).toBe(90);
    expect(r.rule_id).toBe('nonaq-oral');
  });

  it('other nonaqueous → 180 days', () => {
    const r = computeBud({ aw_class: 'nonaqueous', preserved: false, oral: false, dosage_form: 'ointment' });
    expect(r.bud_days).toBe(180);
    expect(r.rule_id).toBe('nonaq-other');
  });

  it('stability data can only SHORTEN the category default', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: true, dosage_form: 'gel', stability_bud_days: 20 });
    expect(r.bud_days).toBe(20);
    expect(r.capped_by_stability).toBe(true);
  });

  it('stability data CANNOT extend beyond the category ceiling', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream', stability_bud_days: 90 });
    expect(r.bud_days).toBe(14);
    expect(r.capped_by_stability).toBe(false);
  });

  it('REGRESSION: hydrocortisone cream (aqueous) never 180 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream' });
    expect(r.bud_days).not.toBe(180);
    expect(r.bud_days).toBe(14);
  });

  it('REGRESSION: ketoprofen PLO gel (aqueous) never 180 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'gel' });
    expect(r.bud_days).not.toBe(180);
    expect(r.bud_days).toBe(14);
  });

  it('throws on an unknown aw_class rather than guessing', () => {
    // @ts-expect-error deliberately invalid
    expect(() => computeBud({ aw_class: 'plasma', preserved: false, dosage_form: 'cream' })).toThrow();
  });
});
