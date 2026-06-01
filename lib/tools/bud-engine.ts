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
