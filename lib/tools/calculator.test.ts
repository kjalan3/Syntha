import { describe, it, expect } from 'vitest';
import { calculateConcentration } from '@/lib/tools/calculator';

describe('calculateConcentration (in-process)', () => {
  it('0.5 g in 100 g → 0.5000%', async () => {
    const r = await calculateConcentration({ ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 });
    expect(r.concentration_pct).toBe('0.5000');
  });

  it('1.0 g in 100 g → 1.0000%', async () => {
    const r = await calculateConcentration({ ingredient: 'hydrocortisone', grams: 1.0, totalGrams: 100 });
    expect(r.concentration_pct).toBe('1.0000');
  });

  it('avoids float drift (0.1 + 0.2 style)', async () => {
    const r = await calculateConcentration({ ingredient: 'x', grams: 0.3, totalGrams: 100 });
    expect(r.concentration_pct).toBe('0.3000');
  });

  it('throws on zero total', async () => {
    await expect(
      calculateConcentration({ ingredient: 'x', grams: 1, totalGrams: 0 }),
    ).rejects.toThrow();
  });
});
