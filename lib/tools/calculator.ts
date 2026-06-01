import Decimal from 'decimal.js';
import type { CalculationResult } from '@/lib/types';

export interface ConcentrationInput {
  ingredient: string;
  grams: number | string;
  totalGrams: number | string;
}

/** Optional sandbox hook; when provided the same math runs in Daytona. */
export interface SandboxRunner {
  id: string;
  run: (code: string) => Promise<{ result: string; exitCode: number; ms: number }>;
}

export async function calculateConcentration(
  input: ConcentrationInput,
  sandbox?: SandboxRunner,
): Promise<CalculationResult> {
  const total = new Decimal(input.totalGrams);
  if (total.isZero()) throw new Error('totalGrams must be non-zero');

  if (sandbox) {
    const g = new Decimal(input.grams);     // already validated parseable by Decimal above for total; validate grams too
    const tg = total;                       // total already constructed and checked non-zero
    if (!g.isFinite() || !tg.isFinite()) throw new Error('non-finite quantity');
    const snippet = `
import Decimal from 'decimal.js';
const pct = new Decimal('${g.toString()}').div('${tg.toString()}').mul(100).toFixed(4);
console.log(JSON.stringify({ concentration_pct: pct }));
`;
    const out = await sandbox.run(snippet);
    const parsed = JSON.parse(out.result) as { concentration_pct: string };
    return { ingredient: input.ingredient, concentration_pct: parsed.concentration_pct };
  }

  const pct = new Decimal(input.grams).div(total).mul(100).toFixed(4);
  return { ingredient: input.ingredient, concentration_pct: pct };
}
