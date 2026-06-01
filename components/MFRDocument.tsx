'use client';
import type { MFRSectionName } from '@/lib/types';

const ORDER: MFRSectionName[] = ['identification', 'ingredients', 'calculations', 'equipment_procedure', 'quality_checks', 'bud', 'storage'];
const TITLES: Record<MFRSectionName, string> = {
  identification: 'Identification', ingredients: 'Ingredients', calculations: 'Calculations',
  equipment_procedure: 'Equipment & Procedure', quality_checks: 'Quality Checks', bud: 'Beyond-Use Date', storage: 'Storage',
};

export function MFRDocument({ sections }: { sections: Partial<Record<MFRSectionName, string>> }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Master Formulation Record</h2>
      {ORDER.filter((s) => sections[s]).map((s) => (
        <div key={s}>
          <h3 className="text-xs font-semibold text-gray-800">{TITLES[s]}</h3>
          <pre className="whitespace-pre-wrap text-sm text-gray-700">{sections[s]}</pre>
        </div>
      ))}
    </div>
  );
}
