import { computeBud } from '@/lib/tools/bud-engine';
import { calculateConcentration, type SandboxRunner } from '@/lib/tools/calculator';
import { lookupStability } from '@/lib/tools/stability-db';
import { buildMfrSection } from '@/lib/tools/mfr-builder';
import type { MFRSectionName } from '@/lib/types';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const DRAFTER_TOOLS: ToolDef[] = [
  {
    name: 'resolve_drug',
    description: 'Resolve a drug name against openFDA drug labeling. Returns label data or a note if unavailable.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'calculate_formulation',
    description: 'Compute the concentration (%) of an ingredient given its grams and the total batch grams. Uses exact decimal math.',
    input_schema: {
      type: 'object',
      properties: {
        ingredient: { type: 'string' },
        grams: { type: 'number' },
        totalGrams: { type: 'number' },
      },
      required: ['ingredient', 'grams', 'totalGrams'],
    },
  },
  {
    name: 'lookup_stability',
    description: 'Look up curated stability data for an ingredient.',
    input_schema: { type: 'object', properties: { ingredient: { type: 'string' } }, required: ['ingredient'] },
  },
  {
    name: 'compute_bud',
    description: 'Deterministically compute the USP 795 beyond-use date. Returns bud_days, storage, and rule citation.',
    input_schema: {
      type: 'object',
      properties: {
        aw_class: { type: 'string', enum: ['aqueous', 'nonaqueous'] },
        preserved: { type: 'boolean' },
        dosage_form: { type: 'string' },
        oral: { type: 'boolean' },
        stability_bud_days: { type: 'number' },
      },
      required: ['aw_class', 'preserved', 'dosage_form'],
    },
  },
  {
    name: 'fill_mfr_section',
    description: 'Render a Master Formulation Record section. Returns { section, content }.',
    input_schema: {
      type: 'object',
      properties: { section: { type: 'string' }, data: { type: 'object' } },
      required: ['section', 'data'],
    },
  },
];

/** Reviewer gets a strict subset — independent recompute only. */
export const REVIEWER_TOOLS: ToolDef[] = DRAFTER_TOOLS.filter((t) =>
  ['calculate_formulation', 'compute_bud'].includes(t.name),
);

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandbox?: SandboxRunner,
): Promise<unknown> {
  switch (name) {
    case 'resolve_drug': {
      try {
        const q = encodeURIComponent(String(input.name));
        const res = await fetch(`https://api.fda.gov/drug/label.json?search=openfda.generic_name:${q}&limit=1`);
        if (!res.ok) return { resolved: false, note: 'label data unavailable' };
        const data = await res.json();
        const r = data.results?.[0];
        return { resolved: !!r, generic_name: r?.openfda?.generic_name ?? [String(input.name)], note: r ? undefined : 'no label match' };
      } catch {
        return { resolved: false, note: 'label data unavailable' };
      }
    }
    case 'calculate_formulation':
      return calculateConcentration(
        { ingredient: String(input.ingredient), grams: input.grams as number, totalGrams: input.totalGrams as number },
        sandbox,
      );
    case 'lookup_stability':
      return lookupStability(String(input.ingredient)) ?? { found: false };
    case 'compute_bud':
      return computeBud({
        aw_class: input.aw_class as 'aqueous' | 'nonaqueous',
        preserved: input.preserved as boolean,
        dosage_form: String(input.dosage_form),
        oral: input.oral as boolean | undefined,
        stability_bud_days: input.stability_bud_days as number | undefined,
      });
    case 'fill_mfr_section':
      return buildMfrSection(input.section as MFRSectionName, (input.data as Record<string, unknown>) ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
