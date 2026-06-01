export type AwClass = 'aqueous' | 'nonaqueous';

export type MFRSectionName =
  | 'identification'
  | 'ingredients'
  | 'calculations'
  | 'equipment_procedure'
  | 'quality_checks'
  | 'bud'
  | 'storage';

/** The order as prescribed, plus the (possibly erroneous) drafted ingredient weight. */
export interface Prescription {
  drug: string;
  strength_pct: number;       // ordered strength, e.g. 5
  dosage_form: string;        // 'cream' | 'gel' | 'solution' | ...
  batch_size_g: number;       // e.g. 100
  preserved: boolean;
  aw_class: AwClass;
  oral?: boolean;             // nonaqueous oral liquid branch
  active_quantity_g: number;  // weight listed in the MFR (planted error lives here)
}

export interface BudResult {
  bud_days: number;
  storage: string;
  rule_id: string;
  rule_citation: string;
  capped_by_stability: boolean;
}

export interface CalculationResult {
  ingredient: string;
  concentration_pct: string;  // decimal string, 4 dp, e.g. "0.5000"
}

export type QAInvariant =
  | 'computed_vs_stated'
  | 'stated_vs_prescribed'
  | 'computed_vs_prescribed'
  | 'ok';

export interface QAFinding {
  severity: 'pass' | 'error' | 'warning';
  field: string;
  prescribed?: string;
  stated?: string;
  computed?: string;
  invariant: QAInvariant;
  message: string;
}

export interface ComplianceSource {
  origin: 'fda_cache' | 'static_fallback';
  fetched_at: string | null;
  stale: boolean;
}

export interface ComplianceResult {
  eligible: boolean;
  status: 'eligible' | 'ineligible' | 'unverifiable';
  drug: string;
  reason?: string;
  source: ComplianceSource;
}

export interface FDAListResult {
  ineligible: { name: string; reason: string }[];
  origin: 'fda_cache' | 'static_fallback';
  fetched_at: string | null;
  stale: boolean;
  authoritative: boolean;
}

export interface FormularyEntry {
  drug: string;
  strength_pct: number;
  dosage_form: string;
  batch_size_g: number;
  ingredients: { name: string; quantity_g: number; role: 'active' | 'base' }[];
  procedure_steps: string[];
  aw_class: AwClass;
  preserved: boolean;
}

export interface StabilityEntry {
  ingredient: string;
  stability_range_days: number;
  optimal_ph: string;
  light_sensitive: boolean;
  storage: string;
  bud_notes: string;
  source: string;
}

export interface ReferencePack {
  formulary: FormularyEntry | null;
  bud_rationale: string;
  stability: StabilityEntry | null;
  compliance: ComplianceResult;
}

export type StreamEvent =
  | { type: 'compliance_result'; eligible: boolean; drug: string; reason?: string;
      status: 'eligible' | 'ineligible' | 'unverifiable';
      source: ComplianceSource }
  | { type: 'agent_start'; agent: 'drafter' | 'reviewer' }
  | { type: 'tool_call'; agent: 'drafter' | 'reviewer'; tool: string; input: unknown }
  | { type: 'tool_result'; agent: 'drafter' | 'reviewer'; tool: string; output: unknown; ms: number }
  | { type: 'sandbox_exec'; code: string; sandbox_id: string }
  | { type: 'sandbox_result'; result: string; exit_code: number; ms: number }
  | { type: 'text_delta'; agent: 'drafter' | 'reviewer'; delta: string }
  | { type: 'mfr_section'; section: MFRSectionName; content: string }
  | { type: 'qa_finding'; severity: 'pass' | 'error' | 'warning'; field: string;
      prescribed?: string; stated?: string; computed?: string;
      invariant: QAInvariant; message: string }
  | { type: 'qa_signoff'; passed: boolean; summary: string }
  | { type: 'audit_status'; run_id: string; state: 'pending' | 'written' | 'failed'; detail?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One recorded event for the audit trail (carries agent + timestamp). */
export interface AuditEvent {
  type: string;
  agent?: 'drafter' | 'reviewer' | null;
  ts: string;
  [k: string]: unknown;
}

export interface AuditRun {
  id: string;                // client-generated uuid (idempotency key)
  formula: Prescription;
  mfr: Record<MFRSectionName, string> | null;
  bud: BudResult | null;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  events: AuditEvent[];
}
