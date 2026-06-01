import type { Prescription } from '@/lib/types';

export interface Scenario {
  id: string;
  label: string;
  prescription: Prescription;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'hydrocortisone',
    label: 'Hydrocortisone 1% Cream (clean pass)',
    prescription: {
      drug: 'hydrocortisone', strength_pct: 1, dosage_form: 'cream', batch_size_g: 100,
      preserved: false, aw_class: 'aqueous', active_quantity_g: 1.0,
    },
  },
  {
    id: 'ketoprofen',
    label: 'Ketoprofen 5% PLO Gel (planted 10× error)',
    prescription: {
      drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100,
      preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5,
    },
  },
  {
    id: 'estriol',
    label: 'Estriol (compliance hard-stop)',
    prescription: {
      drug: 'estriol', strength_pct: 1, dosage_form: 'cream', batch_size_g: 100,
      preserved: false, aw_class: 'aqueous', active_quantity_g: 1.0,
    },
  },
];
