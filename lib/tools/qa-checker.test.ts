import { describe, it, expect } from 'vitest';
import { reconcile } from '@/lib/tools/qa-checker';

describe('reconcile', () => {
  it('all three equal → pass / invariant ok', () => {
    const f = reconcile({ ingredient: 'hydrocortisone', prescribed: '1%', stated: '1.0%', computed: '1.0000%' });
    expect(f.severity).toBe('pass');
    expect(f.invariant).toBe('ok');
  });

  it('computed != stated → arithmetic error', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '0.5%', computed: '0.6%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('computed_vs_stated');
  });

  it('ketoprofen demo: internally consistent but wrong vs order → stated_vs_prescribed', () => {
    const f = reconcile({ ingredient: 'ketoprofen', prescribed: '5%', stated: '0.5%', computed: '0.5000%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('stated_vs_prescribed');
    expect(f.message).toMatch(/does not match the order/i);
  });

  it('missing a value → error (treated as computed_vs_stated)', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '', computed: '0.5%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('computed_vs_stated');
  });

  it('unit mismatch (% vs mg/mL) → error', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '50 mg/mL', computed: '5%' });
    expect(f.severity).toBe('error');
    expect(f.message).toMatch(/unit/i);
  });
});

describe('reconcile fails closed on malformed input', () => {
  const bad = ['+5%', '5e1%', 'NaN', '5%%', '5 %', '1,000%', ''];
  for (const v of bad) {
    it(`rejects "${v}" as error, never pass`, () => {
      const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: v, computed: '5%' });
      expect(f.severity).toBe('error');
    });
  }
  it('missing prescribed → error', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '', stated: '5%', computed: '5%' });
    expect(f.severity).toBe('error');
  });
});
