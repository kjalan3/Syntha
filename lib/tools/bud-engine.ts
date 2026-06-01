import rulesData from '@/lib/data/bud_rules.json';
import type { AwClass, BudResult } from '@/lib/types';

interface BudInput {
  aw_class: AwClass;
  preserved: boolean;
  dosage_form: string;
  oral?: boolean;
  stability_bud_days?: number;
}

interface Rule {
  id: string;
  aw_class: AwClass;
  preserved?: boolean;
  oral?: boolean;
  default_days: number;
  storage: string;
  citation: string;
  applies_to: string[];
}

const RULES = rulesData.rules as Rule[];

/** Highest legitimate aqueous BUD ceiling (preserved aqueous, USP <795>). */
const AQUEOUS_CEILING_DAYS = 35;

/**
 * Fail-closed data guard: aqueous BUDs must never exceed 35 days. If a bad edit
 * to bud_rules.json gives an aqueous rule a larger ceiling (e.g. 180), throw so
 * the app fails to start rather than silently shipping an unsafe BUD.
 */
export function assertAqueousCeiling(
  rules: { id: string; aw_class: string; default_days: number }[],
): void {
  for (const r of rules) {
    if (r.aw_class === 'aqueous' && r.default_days > AQUEOUS_CEILING_DAYS) {
      throw new Error(
        `Invalid bud_rules.json: aqueous rule "${r.id}" has default_days ${r.default_days} > ${AQUEOUS_CEILING_DAYS}; ` +
          `aqueous BUDs must never exceed ${AQUEOUS_CEILING_DAYS} days (USP <795>).`,
      );
    }
  }
}

// Run the invariant once at module load.
assertAqueousCeiling(RULES);

/** Deterministic rule selection — never model judgment. */
function ruleIdFor(input: BudInput): string {
  if (input.aw_class === 'aqueous') {
    return input.preserved ? 'aq-preserved' : 'aq-nonpreserved';
  }
  if (input.aw_class === 'nonaqueous') {
    return input.oral ? 'nonaq-oral' : 'nonaq-other';
  }
  throw new Error(`Unknown aw_class: ${String(input.aw_class)}`);
}

export function computeBud(input: BudInput): BudResult {
  const ruleId = ruleIdFor(input);
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No BUD rule found for id ${ruleId}`);

  const ceiling = rule.default_days;
  const stability = input.stability_bud_days;
  const capped = stability !== undefined && stability < ceiling;
  const bud_days = capped ? stability! : ceiling;

  return {
    bud_days,
    storage: rule.storage,
    rule_id: rule.id,
    rule_citation: rule.citation,
    capped_by_stability: capped,
  };
}
