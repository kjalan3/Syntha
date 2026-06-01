import { describe, it, expect } from 'vitest';
import { dispatchTool, DRAFTER_TOOLS } from '@/lib/agents/anthropic-tools';

describe('dispatchTool', () => {
  it('compute_bud returns deterministic 14 days for aqueous nonpreserved', async () => {
    const out = await dispatchTool('compute_bud', { aw_class: 'aqueous', preserved: false, dosage_form: 'gel' });
    expect((out as { bud_days: number }).bud_days).toBe(14);
  });

  it('calculate_formulation returns 0.5000 for 0.5g/100g', async () => {
    const out = await dispatchTool('calculate_formulation', { ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 });
    expect((out as { concentration_pct: string }).concentration_pct).toBe('0.5000');
  });

  it('lookup_stability returns provenance', async () => {
    const out = await dispatchTool('lookup_stability', { ingredient: 'ketoprofen' });
    expect((out as { source: string }).source).toMatch(/Allen/);
  });

  it('unknown tool throws', async () => {
    await expect(dispatchTool('nope', {})).rejects.toThrow();
  });

  it('exposes JSON-schema tool definitions to the model', () => {
    const names = DRAFTER_TOOLS.map((t) => t.name);
    expect(names).toContain('compute_bud');
    expect(names).toContain('calculate_formulation');
    expect(names).toContain('fill_mfr_section');
  });
});
