'use client';
import { SCENARIOS } from '@/lib/demo/scenarios';
import type { Prescription } from '@/lib/types';

export function FormulaInput({
  onRun, disabled,
}: {
  onRun: (rx: Prescription) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Formula Input</h2>
      <div className="flex flex-col gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            disabled={disabled}
            onClick={() => onRun(s.prescription)}
            className="rounded border border-gray-300 px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
