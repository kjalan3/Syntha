import type { MFRSectionName } from '@/lib/types';

type SectionInput = Record<string, unknown>;

export function buildMfrSection(
  section: MFRSectionName,
  input: SectionInput,
): { section: MFRSectionName; content: string } {
  let content = '';
  switch (section) {
    case 'identification':
      content =
        `Formula ID: ${input.formulaId}\n` +
        `Active: ${input.drug} ${input.strength} ${input.form}`;
      break;
    case 'ingredients': {
      const rows = (input.ingredients as { name: string; quantity_g: number; role: string }[]) ?? [];
      content =
        'Ingredient | Quantity (g) | Role\n' +
        rows.map((r) => `${r.name} | ${r.quantity_g} | ${r.role}`).join('\n');
      break;
    }
    case 'calculations':
      content = String(input.work ?? '');
      break;
    case 'equipment_procedure': {
      const steps = (input.steps as string[]) ?? [];
      content = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      break;
    }
    case 'quality_checks':
      content =
        `pH target: ${input.ph ?? 'n/a'}\n` +
        `Appearance: ${input.appearance ?? 'uniform, no visible particulates'}\n` +
        `Final weight check: ${input.weight ?? 'batch size ± 2%'}`;
      break;
    case 'bud':
      content =
        `Beyond-use date: ${input.bud_days} days\n` +
        `Storage: ${input.storage}\n` +
        `Rule: ${input.citation}`;
      break;
    case 'storage':
      content = String(input.storage ?? '');
      break;
    default:
      content = '';
  }
  return { section, content };
}
