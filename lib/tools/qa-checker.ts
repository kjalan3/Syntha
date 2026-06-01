import Decimal from 'decimal.js';
import type { QAFinding } from '@/lib/types';

export interface ReconcileInput {
  ingredient: string;
  prescribed: string; // e.g. "5%"
  stated: string;     // e.g. "0.5%"
  computed: string;   // e.g. "0.5000%"
}

function parsePercent(raw: string): Decimal {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('missing value');
  // Reject anything that is not a bare percentage (e.g. "50 mg/mL").
  if (!/^[0-9]*\.?[0-9]+\s*%?$/.test(trimmed)) {
    throw new Error(`unit mismatch or unparseable value: "${raw}" (expected a % concentration)`);
  }
  return new Decimal(trimmed.replace('%', ''));
}

export function reconcile(input: ReconcileInput): QAFinding {
  const field = `${input.ingredient} concentration`;
  let p: Decimal, s: Decimal, c: Decimal;
  try {
    p = parsePercent(input.prescribed);
    s = parsePercent(input.stated);
    c = parsePercent(input.computed);
  } catch (err) {
    return {
      severity: 'error',
      field,
      prescribed: input.prescribed,
      stated: input.stated,
      computed: input.computed,
      invariant: 'computed_vs_stated',
      message: `Cannot reconcile ${input.ingredient}: ${(err as Error).message}`,
    };
  }

  if (!c.equals(s)) {
    return {
      severity: 'error', field,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'computed_vs_stated',
      message: `Computed ${input.computed} ≠ stated ${input.stated} — arithmetic or transcription error`,
    };
  }
  if (!s.equals(p)) {
    return {
      severity: 'error', field,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'stated_vs_prescribed',
      message: `Stated/computed ${input.stated} ≠ prescribed ${input.prescribed} — formulation does not match the order`,
    };
  }
  return {
    severity: 'pass', field,
    invariant: 'ok',
    message: `${input.ingredient} concentration verified: prescribed = stated = computed = ${input.stated}`,
  };
}
