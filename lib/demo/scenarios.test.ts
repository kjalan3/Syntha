import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '@/lib/demo/scenarios';

describe('SCENARIOS', () => {
  it('hydrocortisone is a clean pass (stated weight == correct weight)', () => {
    const s = SCENARIOS.find((x) => x.id === 'hydrocortisone')!;
    expect(s.prescription.active_quantity_g).toBe(1.0);
    expect(s.prescription.strength_pct).toBe(1);
  });
  it('ketoprofen plants a 10x decimal slip (0.5 g instead of 5 g)', () => {
    const s = SCENARIOS.find((x) => x.id === 'ketoprofen')!;
    expect(s.prescription.active_quantity_g).toBe(0.5);
    expect(s.prescription.strength_pct).toBe(5);
  });
});
