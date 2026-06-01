import type { StreamEvent } from '@/lib/types';

/** Pre-recorded ketoprofen failure sequence for offline demo (?fallback=true). */
export const FALLBACK_EVENTS: StreamEvent[] = [
  { type: 'compliance_result', eligible: true, drug: 'ketoprofen', status: 'eligible',
    source: { origin: 'fda_cache', fetched_at: '2026-05-31T00:00:00Z', stale: false } },
  { type: 'agent_start', agent: 'drafter' },
  { type: 'tool_call', agent: 'drafter', tool: 'calculate_formulation', input: { ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 } },
  { type: 'tool_result', agent: 'drafter', tool: 'calculate_formulation', output: { concentration_pct: '0.5000' }, ms: 8 },
  { type: 'mfr_section', section: 'identification', content: 'Formula ID: SYN-2026-001\nActive: ketoprofen 5% gel' },
  { type: 'mfr_section', section: 'bud', content: 'Beyond-use date: 14 days\nStorage: Refrigerated (2–8°C)\nRule: USP <795> Table 1 (Nov 1, 2023)' },
  { type: 'agent_start', agent: 'reviewer' },
  { type: 'tool_call', agent: 'reviewer', tool: 'calculate_formulation', input: { ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 } },
  { type: 'tool_result', agent: 'reviewer', tool: 'calculate_formulation', output: { concentration_pct: '0.5000' }, ms: 7 },
  { type: 'qa_finding', severity: 'error', field: 'ketoprofen concentration', prescribed: '5%', stated: '0.5%', computed: '0.5000%',
    invariant: 'stated_vs_prescribed', message: 'Stated/computed 0.5% ≠ prescribed 5% — formulation does not match the order' },
  { type: 'qa_signoff', passed: false, summary: 'FAILED — 10× underdose detected.' },
  { type: 'audit_status', run_id: 'demo-run', state: 'written' },
  { type: 'done' },
];
