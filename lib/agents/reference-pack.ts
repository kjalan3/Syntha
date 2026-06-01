import formularyData from '@/lib/data/formulary.json';
import { lookupStability, getRegulatoryRules } from '@/lib/tools/stability-db';
import { checkCompliance } from '@/lib/tools/compliance-gate';
import type { Prescription, ReferencePack, FormularyEntry } from '@/lib/types';

interface Opts { now?: number; demoOffline?: boolean }

function findFormulary(rx: Prescription): FormularyEntry | null {
  const list = formularyData.formulas as FormularyEntry[];
  return (
    list.find(
      (f) =>
        f.drug.toLowerCase() === rx.drug.toLowerCase() &&
        f.dosage_form.toLowerCase() === rx.dosage_form.toLowerCase(),
    ) ?? null
  );
}

export function buildReferencePack(rx: Prescription, opts: Opts = {}): ReferencePack {
  return {
    formulary: findFormulary(rx),
    bud_rationale: getRegulatoryRules(opts).rationale_text,
    stability: lookupStability(rx.drug),
    compliance: checkCompliance(rx.drug, opts),
  };
}
