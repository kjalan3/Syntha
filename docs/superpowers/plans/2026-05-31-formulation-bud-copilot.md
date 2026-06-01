# Formulation & BUD Copilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Syntha dual-agent Formulation & BUD Copilot — a deterministic compliance gate + drafter/reviewer agents that produce a USP 795 Master Formulation Record with a citation-backed BUD and catch a planted 10× concentration error every run.

**Architecture:** Single Next.js 16 App Router app, one streaming SSE route (`POST /api/generate`). Safety-critical logic (compliance gate, BUD engine, three-way reconciliation, concentration math) is deterministic TypeScript covered by unit tests; the two Claude agents only draft prose and call tools — they never decide pass/fail. Sponsor integrations (Insforge audit, Daytona sandbox, Rtrvr cache) are optional and degrade explicitly, never silently.

**Tech Stack:** Next.js 16.2.6, React 19.2.4, TypeScript 5 (strict), Tailwind v4, `@anthropic-ai/sdk`, `decimal.js`, Vitest. Optional at runtime: `@insforge/sdk`, `@daytona/sdk`.

**Source spec:** `docs/superpowers/specs/2026-05-31-formulation-bud-copilot-design.md` (read the fail-closed compliance, atomic-audit, and BUD-engine sections before starting — those invariants are the point of this app).

**Conventions for every task:**
- Path alias `@/*` maps to repo root (see `tsconfig.json`). Import as `@/lib/...`.
- TDD order: write the failing test, run it red, implement minimally, run it green, commit.
- Money/quantity math uses `decimal.js` only — never JS floats.
- Commit after each task with the message shown in its final step.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Test runner config + `@/*` alias resolution |
| `lib/types/index.ts` | All shared types (StreamEvent, Prescription, BudResult, QAFinding, …) |
| `lib/data/bud_rules.json` | USP 795 Nov-2023 BUD category data (consumed by engine only) |
| `lib/data/formulary.json` | Demo formulas (own-words, structured) |
| `lib/data/stability.json` | Ingredient stability values + provenance |
| `lib/data/fda-compliance-fallback.json` | Static deny-list supplement (non-authoritative) |
| `lib/tools/bud-engine.ts` | Deterministic BUD calculation + rule citation |
| `lib/tools/qa-checker.ts` | `reconcile()` three-way check |
| `lib/tools/calculator.ts` | decimal.js concentration/quantity math (sandbox-aware) |
| `lib/tools/compliance-gate.ts` | Fail-closed FDA eligibility check + provenance |
| `lib/tools/stability-db.ts` | stability lookup + `getRegulatoryRules()` (fail-open rationale) |
| `lib/tools/mfr-builder.ts` | MFR section assembler |
| `lib/agents/reference-pack.ts` | Formula-scoped reference pack assembler |
| `lib/agents/drafter.ts` | Drafter agent: Claude call #1 + tool loop |
| `lib/agents/reviewer.ts` | Reviewer agent: independent Claude call #2 + tool loop |
| `lib/integrations/insforge.ts` | Atomic idempotent `persistRun()` |
| `lib/integrations/daytona.ts` | Sandbox lifecycle (optional) |
| `lib/integrations/rtrvr.ts` | Cache fetch helpers (script-only) |
| `lib/demo/scenarios.ts` | Pre-wired demo inputs |
| `lib/demo/fallback-events.ts` | Pre-recorded offline event sequence |
| `app/api/generate/route.ts` | SSE endpoint orchestrating gate → drafter → reviewer → audit |
| `app/page.tsx` | Main UI shell + SSE client |
| `components/FormulaInput.tsx` | Structured form + demo buttons |
| `components/WorkPanel.tsx` | Live tool-call feed |
| `components/MFRDocument.tsx` | Rendered MFR sections |
| `components/QASignoffPanel.tsx` | Findings + pass/fail + audit/provenance badges |
| `migrations/001_mfr_runs.sql` … `003_persist_run_fn.sql` | Insforge schema + atomic RPC |
| `scripts/refresh-regulatory-cache.ts` | Standalone cache refresh |

---

## Task 1: Project setup — dependencies and test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `lib/data/.gitkeep` (placeholder so the dir exists)
- Modify: `.gitignore`

- [ ] **Step 1: Install runtime + dev dependencies**

Run:
```bash
npm install @anthropic-ai/sdk decimal.js
npm install -D vitest vite-tsconfig-paths
```
Expected: both complete; `package.json` gains the four packages.

- [ ] **Step 2: Add the `test` script**

Edit `package.json` `"scripts"` so it reads:
```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Ignore the runtime cache directory**

Append to `.gitignore`:
```
# Runtime regulatory cache — may contain full-text regulatory content; never commit
/cache/
```

- [ ] **Step 5: Verify the runner works on an empty suite**

Run: `npm test`
Expected: exit 0 with "No test files found" (vitest reports no files but does not fail the `run` invocation). If it exits non-zero, create `lib/data/.gitkeep` and re-run; proceed once exit is 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts .gitignore lib/data/.gitkeep
git commit -m "chore: add anthropic sdk, decimal.js, and vitest test runner"
```

---

## Task 2: Shared types

**Files:**
- Create: `lib/types/index.ts`

- [ ] **Step 1: Write the shared types**

Create `lib/types/index.ts`:
```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/types/index.ts
git commit -m "feat: add shared types for copilot"
```

---

## Task 3: BUD engine (deterministic) — the highest-risk invariant

**Files:**
- Create: `lib/data/bud_rules.json`
- Create: `lib/tools/bud-engine.ts`
- Test: `lib/tools/bud-engine.test.ts`

- [ ] **Step 1: Create the rules data**

Create `lib/data/bud_rules.json`:
```json
{
  "rules": [
    {
      "id": "aq-nonpreserved",
      "aw_class": "aqueous",
      "preserved": false,
      "default_days": 14,
      "storage": "Refrigerated (2–8°C)",
      "citation": "USP <795> Table 1, nonpreserved aqueous dosage forms (Nov 1, 2023)",
      "applies_to": ["cream", "gel", "solution", "suspension", "emulsion", "spray", "lotion"]
    },
    {
      "id": "aq-preserved",
      "aw_class": "aqueous",
      "preserved": true,
      "default_days": 35,
      "storage": "Controlled room temperature or refrigerated",
      "citation": "USP <795> Table 1, preserved aqueous dosage forms (Nov 1, 2023)",
      "applies_to": ["cream", "gel", "solution", "suspension", "emulsion", "spray", "lotion"]
    },
    {
      "id": "nonaq-oral",
      "aw_class": "nonaqueous",
      "oral": true,
      "default_days": 90,
      "storage": "Per stability data; controlled room temperature unless noted",
      "citation": "USP <795> Table 1, nonaqueous oral liquid dosage forms (Nov 1, 2023)",
      "applies_to": ["oral liquid", "oral suspension", "oral solution"]
    },
    {
      "id": "nonaq-other",
      "aw_class": "nonaqueous",
      "oral": false,
      "default_days": 180,
      "storage": "Per stability data; controlled room temperature unless noted",
      "citation": "USP <795> Table 1, other nonaqueous dosage forms (Nov 1, 2023)",
      "applies_to": ["ointment", "suppository", "capsule", "powder", "stick"]
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `lib/tools/bud-engine.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeBud } from '@/lib/tools/bud-engine';

describe('computeBud', () => {
  it('aqueous nonpreserved → 14 days refrigerated', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream' });
    expect(r.bud_days).toBe(14);
    expect(r.rule_id).toBe('aq-nonpreserved');
    expect(r.storage).toMatch(/Refrigerated/i);
    expect(r.rule_citation).toContain('USP <795>');
  });

  it('aqueous preserved → 35 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: true, dosage_form: 'gel' });
    expect(r.bud_days).toBe(35);
    expect(r.rule_id).toBe('aq-preserved');
  });

  it('nonaqueous oral liquid → 90 days', () => {
    const r = computeBud({ aw_class: 'nonaqueous', preserved: false, oral: true, dosage_form: 'oral solution' });
    expect(r.bud_days).toBe(90);
    expect(r.rule_id).toBe('nonaq-oral');
  });

  it('other nonaqueous → 180 days', () => {
    const r = computeBud({ aw_class: 'nonaqueous', preserved: false, oral: false, dosage_form: 'ointment' });
    expect(r.bud_days).toBe(180);
    expect(r.rule_id).toBe('nonaq-other');
  });

  it('stability data can only SHORTEN the category default', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: true, dosage_form: 'gel', stability_bud_days: 20 });
    expect(r.bud_days).toBe(20);
    expect(r.capped_by_stability).toBe(true);
  });

  it('stability data CANNOT extend beyond the category ceiling', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream', stability_bud_days: 90 });
    expect(r.bud_days).toBe(14);
    expect(r.capped_by_stability).toBe(false);
  });

  // Regression guard demanded by the spec: demo formulas must never get 180 days.
  it('REGRESSION: hydrocortisone cream (aqueous) never 180 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'cream' });
    expect(r.bud_days).not.toBe(180);
    expect(r.bud_days).toBe(14);
  });

  it('REGRESSION: ketoprofen PLO gel (aqueous) never 180 days', () => {
    const r = computeBud({ aw_class: 'aqueous', preserved: false, dosage_form: 'gel' });
    expect(r.bud_days).not.toBe(180);
    expect(r.bud_days).toBe(14);
  });

  it('throws on an unknown aw_class rather than guessing', () => {
    // @ts-expect-error deliberately invalid
    expect(() => computeBud({ aw_class: 'plasma', preserved: false, dosage_form: 'cream' })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/tools/bud-engine.test.ts`
Expected: FAIL — "Cannot find module '@/lib/tools/bud-engine'".

- [ ] **Step 4: Implement the engine**

Create `lib/tools/bud-engine.ts`:
```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/tools/bud-engine.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/data/bud_rules.json lib/tools/bud-engine.ts lib/tools/bud-engine.test.ts
git commit -m "feat: deterministic USP 795 BUD engine with branch + regression tests"
```

---

## Task 4: Concentration calculator (decimal.js)

**Files:**
- Create: `lib/tools/calculator.ts`
- Test: `lib/tools/calculator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/tools/calculator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { calculateConcentration } from '@/lib/tools/calculator';

describe('calculateConcentration (in-process)', () => {
  it('0.5 g in 100 g → 0.5000%', async () => {
    const r = await calculateConcentration({ ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 });
    expect(r.concentration_pct).toBe('0.5000');
  });

  it('1.0 g in 100 g → 1.0000%', async () => {
    const r = await calculateConcentration({ ingredient: 'hydrocortisone', grams: 1.0, totalGrams: 100 });
    expect(r.concentration_pct).toBe('1.0000');
  });

  it('avoids float drift (0.1 + 0.2 style)', async () => {
    const r = await calculateConcentration({ ingredient: 'x', grams: 0.3, totalGrams: 100 });
    expect(r.concentration_pct).toBe('0.3000');
  });

  it('throws on zero total', async () => {
    await expect(
      calculateConcentration({ ingredient: 'x', grams: 1, totalGrams: 0 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/tools/calculator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the calculator**

Create `lib/tools/calculator.ts`:
```ts
import Decimal from 'decimal.js';
import type { CalculationResult } from '@/lib/types';

export interface ConcentrationInput {
  ingredient: string;
  grams: number | string;
  totalGrams: number | string;
}

/** Optional sandbox hook; when provided the same math runs in Daytona. */
export interface SandboxRunner {
  id: string;
  run: (code: string) => Promise<{ result: string; exitCode: number; ms: number }>;
}

export async function calculateConcentration(
  input: ConcentrationInput,
  sandbox?: SandboxRunner,
): Promise<CalculationResult> {
  const total = new Decimal(input.totalGrams);
  if (total.isZero()) throw new Error('totalGrams must be non-zero');

  if (sandbox) {
    const snippet = `
import Decimal from 'decimal.js';
const pct = new Decimal('${input.grams}').div('${input.totalGrams}').mul(100).toFixed(4);
console.log(JSON.stringify({ concentration_pct: pct }));
`;
    const out = await sandbox.run(snippet);
    const parsed = JSON.parse(out.result) as { concentration_pct: string };
    return { ingredient: input.ingredient, concentration_pct: parsed.concentration_pct };
  }

  const pct = new Decimal(input.grams).div(total).mul(100).toFixed(4);
  return { ingredient: input.ingredient, concentration_pct: pct };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/tools/calculator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tools/calculator.ts lib/tools/calculator.test.ts
git commit -m "feat: decimal.js concentration calculator with sandbox hook"
```

---

## Task 5: Three-way reconciliation (`reconcile`)

**Files:**
- Create: `lib/tools/qa-checker.ts`
- Test: `lib/tools/qa-checker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/tools/qa-checker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { reconcile } from '@/lib/tools/qa-checker';

describe('reconcile', () => {
  it('all three equal → pass / invariant ok', () => {
    const f = reconcile({ ingredient: 'hydrocortisone', prescribed: '1%', stated: '1.0%', computed: '1.0000%' });
    expect(f.severity).toBe('pass');
    expect(f.invariant).toBe('ok');
  });

  it('computed != stated → arithmetic error', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '0.5%', computed: '0.6%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('computed_vs_stated');
  });

  it('ketoprofen demo: internally consistent but wrong vs order → stated_vs_prescribed', () => {
    const f = reconcile({ ingredient: 'ketoprofen', prescribed: '5%', stated: '0.5%', computed: '0.5000%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('stated_vs_prescribed');
    expect(f.message).toMatch(/does not match the order/i);
  });

  it('missing a value → error (treated as computed_vs_stated)', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '', computed: '0.5%' });
    expect(f.severity).toBe('error');
    expect(f.invariant).toBe('computed_vs_stated');
  });

  it('unit mismatch (% vs mg/mL) → error', () => {
    const f = reconcile({ ingredient: 'x', prescribed: '5%', stated: '50 mg/mL', computed: '5%' });
    expect(f.severity).toBe('error');
    expect(f.message).toMatch(/unit/i);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/tools/qa-checker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reconcile**

Create `lib/tools/qa-checker.ts`:
```ts
import Decimal from 'decimal.js';
import type { QAFinding } from '@/lib/types';

export interface ReconcileInput {
  ingredient: string;
  prescribed: string; // e.g. "5%"
  stated: string;     // e.g. "0.5%"
  computed: string;   // e.g. "0.5000%"
}

function parsePercent(raw: string): Decimal {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('missing value');
  // Reject anything that is not a bare percentage (e.g. "50 mg/mL").
  if (!/^[0-9]*\.?[0-9]+\s*%?$/.test(trimmed)) {
    throw new Error(`unit mismatch or unparseable value: "${raw}" (expected a % concentration)`);
  }
  return new Decimal(trimmed.replace('%', ''));
}

export function reconcile(input: ReconcileInput): QAFinding {
  const field = `${input.ingredient} concentration`;
  let p: Decimal, s: Decimal, c: Decimal;
  try {
    p = parsePercent(input.prescribed);
    s = parsePercent(input.stated);
    c = parsePercent(input.computed);
  } catch (err) {
    return {
      severity: 'error',
      field,
      prescribed: input.prescribed,
      stated: input.stated,
      computed: input.computed,
      invariant: 'computed_vs_stated',
      message: `Cannot reconcile ${input.ingredient}: ${(err as Error).message}`,
    };
  }

  if (!c.equals(s)) {
    return {
      severity: 'error', field,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'computed_vs_stated',
      message: `Computed ${input.computed} ≠ stated ${input.stated} — arithmetic or transcription error`,
    };
  }
  if (!s.equals(p)) {
    return {
      severity: 'error', field,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'stated_vs_prescribed',
      message: `Stated/computed ${input.stated} ≠ prescribed ${input.prescribed} — formulation does not match the order`,
    };
  }
  return {
    severity: 'pass', field,
    invariant: 'ok',
    message: `${input.ingredient} concentration verified: prescribed = stated = computed = ${input.stated}`,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/tools/qa-checker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tools/qa-checker.ts lib/tools/qa-checker.test.ts
git commit -m "feat: three-way reconcile() with arithmetic vs order-mismatch invariants"
```

---

## Task 6: Compliance gate (fail-closed) + FDA list reader

**Files:**
- Create: `lib/data/fda-compliance-fallback.json`
- Create: `lib/tools/compliance-gate.ts`
- Test: `lib/tools/compliance-gate.test.ts`

- [ ] **Step 1: Create the static fallback list**

Create `lib/data/fda-compliance-fallback.json`:
```json
{
  "updated": "2026-05-31",
  "source": "FDA 503A Bulks List / Drug Safety Withdrawals (static fallback — non-authoritative)",
  "ineligible": [
    { "name": "estriol", "reason": "On FDA 503A difficult-to-compound list" },
    { "name": "bromocriptine", "reason": "Withdrawn for safety — not for compounding" }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

The gate reads `cache/fda-list.json` if present; tests control that path via a `now` injection and a temp cache path. Create `lib/tools/compliance-gate.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkCompliance } from '@/lib/tools/compliance-gate';

const TMP = join(process.cwd(), 'cache');
const FDA = join(TMP, 'fda-list.json');
const FIXED_NOW = new Date('2026-05-31T12:00:00Z').getTime();

function writeCache(fetchedAt: string, ineligible: { name: string; reason: string }[]) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(FDA, JSON.stringify({ fetched_at: fetchedAt, ineligible }));
}

afterEach(() => { if (existsSync(FDA)) rmSync(FDA); });

describe('checkCompliance (fail-closed)', () => {
  it('fresh cache, drug not listed → eligible from fda_cache', () => {
    writeCache('2026-05-30T12:00:00Z', []);
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW });
    expect(r.eligible).toBe(true);
    expect(r.status).toBe('eligible');
    expect(r.source.origin).toBe('fda_cache');
    expect(r.source.stale).toBe(false);
  });

  it('fresh cache, drug listed → ineligible', () => {
    writeCache('2026-05-30T12:00:00Z', [{ name: 'estriol', reason: 'on list' }]);
    const r = checkCompliance('Estriol', { now: FIXED_NOW });
    expect(r.eligible).toBe(false);
    expect(r.status).toBe('ineligible');
  });

  it('NO cache, not in demo mode → unverifiable (fail closed)', () => {
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: false });
    expect(r.eligible).toBe(false);
    expect(r.status).toBe('unverifiable');
    expect(r.source.origin).toBe('static_fallback');
  });

  it('NO cache but on static list → still ineligible (deny-list always blocks)', () => {
    const r = checkCompliance('bromocriptine', { now: FIXED_NOW, demoOffline: false });
    expect(r.status).toBe('ineligible');
  });

  it('NO cache but demo offline mode ON → eligible against fallback, marked non-authoritative', () => {
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: true });
    expect(r.eligible).toBe(true);
    expect(r.status).toBe('eligible');
    expect(r.source.origin).toBe('static_fallback');
    expect(r.source.stale).toBe(true);
  });

  it('STALE cache (>7 days), not in demo mode → unverifiable', () => {
    writeCache('2026-05-01T12:00:00Z', []); // 30 days old
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: false });
    expect(r.status).toBe('unverifiable');
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run lib/tools/compliance-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the gate**

Create `lib/tools/compliance-gate.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fallback from '@/lib/data/fda-compliance-fallback.json';
import type { ComplianceResult, FDAListResult, ComplianceSource } from '@/lib/types';

const CACHE_FDA_PATH = join(process.cwd(), 'cache', 'fda-list.json');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface Options {
  now?: number;
  demoOffline?: boolean;
  cachePath?: string;
}

export function getFDAList(opts: Options = {}): FDAListResult {
  const now = opts.now ?? Date.now();
  const path = opts.cachePath ?? CACHE_FDA_PATH;
  try {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf-8'));
      const age = now - new Date(cached.fetched_at).getTime();
      const stale = age > STALE_MS;
      return {
        ineligible: cached.ineligible ?? [],
        origin: 'fda_cache',
        fetched_at: cached.fetched_at,
        stale,
        authoritative: !stale,
      };
    }
  } catch {
    /* fall through to static fallback */
  }
  return {
    ineligible: fallback.ineligible ?? [],
    origin: 'static_fallback',
    fetched_at: fallback.updated ?? null,
    stale: true,
    authoritative: false,
  };
}

function provenance(list: FDAListResult): ComplianceSource {
  return { origin: list.origin, fetched_at: list.fetched_at, stale: list.stale };
}

function matches(listName: string, drug: string): boolean {
  return listName.trim().toLowerCase() === drug.trim().toLowerCase();
}

export function checkCompliance(drug: string, opts: Options = {}): ComplianceResult {
  const demoOffline = opts.demoOffline ?? process.env.DEMO_OFFLINE_MODE === 'true';
  const list = getFDAList(opts);
  const hit = list.ineligible.find((e) => matches(e.name, drug));

  // A positive match always blocks, regardless of source freshness.
  if (hit) {
    return { eligible: false, status: 'ineligible', drug, reason: hit.reason, source: provenance(list) };
  }

  // "Not found" only certifies eligibility against an authoritative list.
  if (!list.authoritative && !demoOffline) {
    return {
      eligible: false,
      status: 'unverifiable',
      drug,
      reason:
        'FDA difficult-to-compound list could not be confirmed current; refusing to certify eligibility. Run scripts/refresh-regulatory-cache.ts.',
      source: provenance(list),
    };
  }

  return { eligible: true, status: 'eligible', drug, source: provenance(list) };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/tools/compliance-gate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/data/fda-compliance-fallback.json lib/tools/compliance-gate.ts lib/tools/compliance-gate.test.ts
git commit -m "feat: fail-closed compliance gate with provenance and demo-offline opt-in"
```

---

## Task 7: Stability DB + regulatory rationale reader

**Files:**
- Create: `lib/data/stability.json`
- Create: `lib/tools/stability-db.ts`
- Test: `lib/tools/stability-db.test.ts`

- [ ] **Step 1: Create stability data**

Create `lib/data/stability.json`:
```json
{
  "ingredients": [
    {
      "ingredient": "ketoprofen",
      "stability_range_days": 90,
      "optimal_ph": "5.0–6.5",
      "light_sensitive": true,
      "storage": "refrigerated",
      "bud_notes": "Stable in PLO gel base for 90 days at refrigerated temps.",
      "source": "Allen LV Jr. (2012). The Art, Science, and Technology of Pharmaceutical Compounding, 4th ed."
    },
    {
      "ingredient": "hydrocortisone",
      "stability_range_days": 30,
      "optimal_ph": "5.0–7.0",
      "light_sensitive": false,
      "storage": "controlled room temperature",
      "bud_notes": "Stable in hydrophilic ointment base; aqueous cream BUD governed by USP 795 category.",
      "source": "Allen LV Jr. (2012). The Art, Science, and Technology of Pharmaceutical Compounding, 4th ed."
    }
  ]
}
```

- [ ] **Step 2: Write failing tests**

Create `lib/tools/stability-db.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { lookupStability, getRegulatoryRules } from '@/lib/tools/stability-db';

describe('lookupStability', () => {
  it('finds a known ingredient (case-insensitive)', () => {
    const e = lookupStability('Ketoprofen');
    expect(e?.stability_range_days).toBe(90);
  });
  it('returns null for an unknown ingredient', () => {
    expect(lookupStability('unobtainium')).toBeNull();
  });
});

describe('getRegulatoryRules (fail-open rationale)', () => {
  it('returns a non-empty rationale string even with no cache', () => {
    const r = getRegulatoryRules({ cachePath: '/nonexistent/path.json' });
    expect(typeof r.rationale_text).toBe('string');
    expect(r.rationale_text.length).toBeGreaterThan(0);
    expect(r.source).toMatch(/bundled|USP/i);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run lib/tools/stability-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/tools/stability-db.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import stabilityData from '@/lib/data/stability.json';
import type { StabilityEntry } from '@/lib/types';

const CACHE_REG_PATH = join(process.cwd(), 'cache', 'regulatory.json');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const BUNDLED_RATIONALE =
  'USP <795> (effective Nov 1, 2023) sets beyond-use dates by water-activity class and ' +
  'preservation: nonpreserved aqueous = 14 days refrigerated; preserved aqueous = 35 days; ' +
  'nonaqueous oral liquids = 90 days; other nonaqueous = 180 days. Stability data may only ' +
  'shorten these category defaults.';

export function lookupStability(ingredient: string): StabilityEntry | null {
  const target = ingredient.trim().toLowerCase();
  const list = stabilityData.ingredients as StabilityEntry[];
  return list.find((e) => e.ingredient.toLowerCase() === target) ?? null;
}

interface RegOpts { now?: number; cachePath?: string }

/** Fail-OPEN: rationale text only; deterministic BUD math never depends on this. */
export function getRegulatoryRules(opts: RegOpts = {}): { rationale_text: string; source: string } {
  const now = opts.now ?? Date.now();
  const path = opts.cachePath ?? CACHE_REG_PATH;
  try {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf-8'));
      const age = now - new Date(cached.fetched_at).getTime();
      if (age <= STALE_MS && typeof cached.rationale_text === 'string') {
        return { rationale_text: cached.rationale_text, source: cached.source ?? 'cache/regulatory.json' };
      }
    }
  } catch {
    /* fall through */
  }
  return { rationale_text: BUNDLED_RATIONALE, source: 'bundled USP <795> rationale (Nov 1, 2023)' };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/tools/stability-db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/data/stability.json lib/tools/stability-db.ts lib/tools/stability-db.test.ts
git commit -m "feat: stability lookup and fail-open regulatory rationale reader"
```

---

## Task 8: Formulary data + reference pack assembler

**Files:**
- Create: `lib/data/formulary.json`
- Create: `lib/agents/reference-pack.ts`
- Test: `lib/agents/reference-pack.test.ts`

- [ ] **Step 1: Create formulary data**

Create `lib/data/formulary.json`:
```json
{
  "formulas": [
    {
      "drug": "hydrocortisone",
      "strength_pct": 1,
      "dosage_form": "cream",
      "batch_size_g": 100,
      "ingredients": [
        { "name": "Hydrocortisone USP", "quantity_g": 1.0, "role": "active" },
        { "name": "Hydrophilic ointment base", "quantity_g": 99.0, "role": "base" }
      ],
      "procedure_steps": [
        "Weigh hydrocortisone on a calibrated analytical balance.",
        "Levigate with a small amount of base to form a smooth paste.",
        "Geometrically incorporate the remaining base; mix until uniform."
      ],
      "aw_class": "aqueous",
      "preserved": false
    },
    {
      "drug": "ketoprofen",
      "strength_pct": 5,
      "dosage_form": "gel",
      "batch_size_g": 100,
      "ingredients": [
        { "name": "Ketoprofen USP", "quantity_g": 5.0, "role": "active" },
        { "name": "PLO gel base", "quantity_g": 95.0, "role": "base" }
      ],
      "procedure_steps": [
        "Weigh ketoprofen on a calibrated analytical balance.",
        "Wet with a few drops of lecithin/isopropyl palmitate solution.",
        "Incorporate into PLO gel base; shear until a uniform gel forms."
      ],
      "aw_class": "aqueous",
      "preserved": false
    }
  ]
}
```

- [ ] **Step 2: Write failing tests**

Create `lib/agents/reference-pack.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildReferencePack } from '@/lib/agents/reference-pack';
import type { Prescription } from '@/lib/types';

const rx: Prescription = {
  drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5,
};

describe('buildReferencePack', () => {
  it('returns exactly the single matching formulary + stability entry', () => {
    const pack = buildReferencePack(rx, { now: new Date('2026-05-31T12:00:00Z').getTime(), demoOffline: true });
    expect(pack.formulary?.drug).toBe('ketoprofen');
    expect(pack.stability?.ingredient).toBe('ketoprofen');
    expect(pack.bud_rationale.length).toBeGreaterThan(0);
    expect(pack.compliance.drug).toBe('ketoprofen');
  });

  it('null formulary/stability for an unknown drug, still returns compliance', () => {
    const pack = buildReferencePack(
      { ...rx, drug: 'unobtainium' },
      { now: Date.now(), demoOffline: true },
    );
    expect(pack.formulary).toBeNull();
    expect(pack.stability).toBeNull();
    expect(pack.compliance).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run lib/agents/reference-pack.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/agents/reference-pack.ts`:
```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/agents/reference-pack.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/data/formulary.json lib/agents/reference-pack.ts lib/agents/reference-pack.test.ts
git commit -m "feat: formula-scoped reference pack assembler"
```

---

## Task 9: MFR builder

**Files:**
- Create: `lib/tools/mfr-builder.ts`
- Test: `lib/tools/mfr-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/tools/mfr-builder.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildMfrSection } from '@/lib/tools/mfr-builder';

describe('buildMfrSection', () => {
  it('returns the section name and non-empty content', () => {
    const r = buildMfrSection('identification', { formulaId: 'SYN-2026-001', drug: 'ketoprofen', strength: '5%', form: 'gel' });
    expect(r.section).toBe('identification');
    expect(r.content).toContain('SYN-2026-001');
    expect(r.content).toContain('ketoprofen');
  });

  it('renders an ingredients table', () => {
    const r = buildMfrSection('ingredients', {
      ingredients: [{ name: 'Ketoprofen USP', quantity_g: 5, role: 'active' }],
    });
    expect(r.section).toBe('ingredients');
    expect(r.content).toContain('Ketoprofen USP');
    expect(r.content).toContain('5');
  });

  it('renders a bud section with citation', () => {
    const r = buildMfrSection('bud', { bud_days: 14, storage: 'Refrigerated', citation: 'USP <795> Table 1' });
    expect(r.content).toContain('14');
    expect(r.content).toContain('USP <795> Table 1');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/tools/mfr-builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/tools/mfr-builder.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/tools/mfr-builder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tools/mfr-builder.ts lib/tools/mfr-builder.test.ts
git commit -m "feat: MFR section builder"
```

---

## Task 10: Insforge integration (atomic, idempotent persist)

**Files:**
- Create: `lib/integrations/insforge.ts`
- Create: `migrations/001_mfr_runs.sql`
- Create: `migrations/002_agent_decisions.sql`
- Create: `migrations/003_persist_run_fn.sql`
- Test: `lib/integrations/insforge.test.ts`

> `@insforge/sdk` is optional. To avoid a hard build dependency, the client is loaded via dynamic import inside the function and only when env vars are set. The retry/idempotency/audit-disabled logic is what we unit-test (with an injected fake client), not the network.

- [ ] **Step 1: Write the migrations**

Create `migrations/001_mfr_runs.sql`:
```sql
create table if not exists mfr_runs (
  id          uuid primary key,            -- client-generated idempotency key
  formula     jsonb not null,
  mfr         jsonb,
  bud         jsonb,
  passed      boolean,
  started_at  timestamptz not null,
  finished_at timestamptz
);
```

Create `migrations/002_agent_decisions.sql`:
```sql
create table if not exists agent_decisions (
  id       uuid primary key default gen_random_uuid(),
  run_id   uuid not null references mfr_runs(id),
  idx      integer not null,
  agent    text,
  kind     text not null,
  payload  jsonb not null,
  ts       timestamptz not null default now(),
  unique (run_id, idx)
);
```

Create `migrations/003_persist_run_fn.sql`:
```sql
-- Atomic, idempotent persistence: run row + all decisions in one transaction.
create or replace function persist_run(p_run jsonb, p_decisions jsonb)
returns void
language plpgsql
as $$
begin
  insert into mfr_runs (id, formula, mfr, bud, passed, started_at, finished_at)
  values (
    (p_run->>'id')::uuid,
    p_run->'formula',
    p_run->'mfr',
    p_run->'bud',
    (p_run->>'passed')::boolean,
    (p_run->>'started_at')::timestamptz,
    (p_run->>'finished_at')::timestamptz
  )
  on conflict (id) do nothing;

  insert into agent_decisions (run_id, idx, agent, kind, payload, ts)
  select
    (p_run->>'id')::uuid,
    (d->>'idx')::int,
    d->>'agent',
    d->>'kind',
    d->'payload',
    (d->>'ts')::timestamptz
  from jsonb_array_elements(p_decisions) as d
  on conflict (run_id, idx) do nothing;
end;
$$;
```

- [ ] **Step 2: Write failing tests**

Create `lib/integrations/insforge.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { persistRun } from '@/lib/integrations/insforge';
import type { AuditRun } from '@/lib/types';

const run: AuditRun = {
  id: '11111111-1111-1111-1111-111111111111',
  formula: { drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100, preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5 },
  mfr: null, bud: null, passed: false,
  startedAt: '2026-05-31T12:00:00Z', finishedAt: '2026-05-31T12:00:30Z',
  events: [{ type: 'tool_call', agent: 'drafter', ts: '2026-05-31T12:00:01Z' }],
};

describe('persistRun', () => {
  it('returns "written" on a successful RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await persistRun(run, { client: { database: { rpc } } });
    expect(res).toBe('written');
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('persist_run', expect.objectContaining({ p_run: expect.objectContaining({ id: run.id }) }));
  });

  it('retries then returns "failed" after 3 errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: new Error('network') });
    const res = await persistRun(run, { client: { database: { rpc } } });
    expect(res).toBe('failed');
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('returns "failed" with no client (audit disabled)', async () => {
    const res = await persistRun(run, { client: null });
    expect(res).toBe('failed');
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run lib/integrations/insforge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `lib/integrations/insforge.ts`:
```ts
import type { AuditRun } from '@/lib/types';

interface InsforgeClient {
  database: { rpc: (fn: string, args: unknown) => Promise<{ error: unknown }> };
}

interface PersistOpts {
  client?: InsforgeClient | null; // injectable for tests
}

let cachedClient: InsforgeClient | null | undefined;

/** Lazily build the client; returns null when env is not configured. */
async function getClient(): Promise<InsforgeClient | null> {
  if (cachedClient !== undefined) return cachedClient;
  const baseUrl = process.env.INSFORGE_BASE_URL;
  const anonKey = process.env.INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) {
    cachedClient = null;
    return null;
  }
  const { createClient } = await import('@insforge/sdk');
  cachedClient = createClient({ baseUrl, anonKey }) as unknown as InsforgeClient;
  return cachedClient;
}

export async function persistRun(
  run: AuditRun,
  opts: PersistOpts = {},
): Promise<'written' | 'failed'> {
  const client = opts.client !== undefined ? opts.client : await getClient();
  if (!client) return 'failed'; // audit disabled / not configured

  const p_decisions = run.events.map((e, idx) => ({
    idx,
    agent: e.agent ?? null,
    kind: e.type,
    payload: e,
    ts: e.ts,
  }));
  const p_run = {
    id: run.id,
    formula: run.formula,
    mfr: run.mfr,
    bud: run.bud,
    passed: run.passed,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await client.database.rpc('persist_run', { p_run, p_decisions });
      if (error) throw error;
      return 'written';
    } catch (err) {
      console.error(`[insforge] audit write attempt ${attempt} failed:`, err);
      if (attempt === 3) return 'failed';
    }
  }
  return 'failed';
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/integrations/insforge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/integrations/insforge.ts migrations/ lib/integrations/insforge.test.ts
git commit -m "feat: atomic idempotent insforge persistRun + migrations"
```

---

## Task 11: Daytona + Rtrvr integrations (optional, no live-path tests)

**Files:**
- Create: `lib/integrations/daytona.ts`
- Create: `lib/integrations/rtrvr.ts`

> Both use dynamic imports so the app builds without the optional packages. No unit tests (pure network glue); they are exercised manually with keys set.

- [ ] **Step 1: Implement Daytona wrapper**

Create `lib/integrations/daytona.ts`:
```ts
import type { SandboxRunner } from '@/lib/tools/calculator';

/** Returns a SandboxRunner, or null if Daytona is unavailable (caller falls back to in-process). */
export async function createCalcSandbox(): Promise<(SandboxRunner & { destroy: () => Promise<void> }) | null> {
  if (!process.env.DAYTONA_API_KEY) return null;
  try {
    const { Daytona } = await import('@daytona/sdk');
    const daytona = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_SERVER_URL,
    });
    const sandbox = await daytona.create({ language: 'typescript' });
    return {
      id: sandbox.id,
      run: async (code: string) => {
        const t0 = Date.now();
        const response = await sandbox.process.codeRun(code);
        return { result: response.result, exitCode: response.exitCode, ms: Date.now() - t0 };
      },
      destroy: async () => {
        try { await sandbox.delete(); } catch { /* best-effort */ }
      },
    };
  } catch (err) {
    console.error('[daytona] sandbox unavailable, falling back to in-process:', err);
    return null;
  }
}
```

- [ ] **Step 2: Implement Rtrvr helper (script use only)**

Create `lib/integrations/rtrvr.ts`:
```ts
export async function callRtrvr(input: string, urls: string[]): Promise<unknown> {
  const res = await fetch('https://api.rtrvr.ai/agent', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RTRVR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, urls, response: { verbosity: 'final' } }),
  });
  if (!res.ok) throw new Error(`Rtrvr error ${res.status}`);
  const data = await res.json();
  return data.result?.json ?? data.result;
}
```

- [ ] **Step 3: Typecheck (no tests for this task)**

Run: `npx tsc --noEmit`
Expected: PASS. (If the optional `@daytona/sdk` / `@insforge/sdk` types are missing, the dynamic-import `await import(...)` calls are typed as `any` under `skipLibCheck: true`; confirm no errors. If `tsc` complains about a missing module type, add `// @ts-expect-error optional dependency` directly above the failing `await import(...)` line.)

- [ ] **Step 4: Commit**

```bash
git add lib/integrations/daytona.ts lib/integrations/rtrvr.ts
git commit -m "feat: optional daytona sandbox and rtrvr cache helpers"
```

---

## Task 12: Drafter agent

**Files:**
- Create: `lib/agents/anthropic-tools.ts` (shared tool schemas + dispatcher)
- Create: `lib/agents/drafter.ts`
- Test: `lib/agents/anthropic-tools.test.ts`

> The agents run a real Claude tool loop, which needs `ANTHROPIC_API_KEY` — not unit-tested here. What we DO test is the deterministic tool **dispatcher** (the code that executes a tool call and returns a result), since that is where correctness lives. The agent file wires the dispatcher into `anthropic.messages.create`.

- [ ] **Step 1: Write failing tests for the dispatcher**

Create `lib/agents/anthropic-tools.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { dispatchTool, DRAFTER_TOOLS } from '@/lib/agents/anthropic-tools';

describe('dispatchTool', () => {
  it('compute_bud returns deterministic 14 days for aqueous nonpreserved', async () => {
    const out = await dispatchTool('compute_bud', { aw_class: 'aqueous', preserved: false, dosage_form: 'gel' });
    expect((out as { bud_days: number }).bud_days).toBe(14);
  });

  it('calculate_formulation returns 0.5000 for 0.5g/100g', async () => {
    const out = await dispatchTool('calculate_formulation', { ingredient: 'ketoprofen', grams: 0.5, totalGrams: 100 });
    expect((out as { concentration_pct: string }).concentration_pct).toBe('0.5000');
  });

  it('lookup_stability returns provenance', async () => {
    const out = await dispatchTool('lookup_stability', { ingredient: 'ketoprofen' });
    expect((out as { source: string }).source).toMatch(/Allen/);
  });

  it('unknown tool throws', async () => {
    await expect(dispatchTool('nope', {})).rejects.toThrow();
  });

  it('exposes JSON-schema tool definitions to the model', () => {
    const names = DRAFTER_TOOLS.map((t) => t.name);
    expect(names).toContain('compute_bud');
    expect(names).toContain('calculate_formulation');
    expect(names).toContain('fill_mfr_section');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/agents/anthropic-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher + tool schemas**

Create `lib/agents/anthropic-tools.ts`:
```ts
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
      // One live openFDA call; degrade gracefully.
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/agents/anthropic-tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the drafter agent (Claude tool loop)**

Create `lib/agents/drafter.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { DRAFTER_TOOLS, dispatchTool } from '@/lib/agents/anthropic-tools';
import type { SandboxRunner } from '@/lib/tools/calculator';
import type { Prescription, ReferencePack, StreamEvent, MFRSectionName } from '@/lib/types';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export interface DrafterResult {
  sections: Partial<Record<MFRSectionName, string>>;
  statedConcentrationPct: string | null; // active ingredient stated concentration
}

function systemPrompt(pack: ReferencePack): string {
  return [
    'You are a pharmacy compounding assistant drafting a USP 795 Master Formulation Record.',
    'Use ONLY the provided tools for all math and BUD decisions — never compute in your head.',
    'Draft faithfully from the given quantities even if they look wrong; a separate reviewer will check them.',
    '',
    'REFERENCE PACK (the only reference data you have):',
    `- Formulary: ${JSON.stringify(pack.formulary)}`,
    `- BUD rationale: ${pack.bud_rationale}`,
    `- Stability: ${JSON.stringify(pack.stability)}`,
    `- Compliance: ${JSON.stringify(pack.compliance)}`,
    '',
    'Fill these MFR sections in order via fill_mfr_section: identification, ingredients,',
    'calculations, equipment_procedure, quality_checks, bud, storage.',
  ].join('\n');
}

export async function runDrafter(
  rx: Prescription,
  pack: ReferencePack,
  emit: (e: StreamEvent) => void,
  sandbox?: SandboxRunner,
): Promise<DrafterResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  emit({ type: 'agent_start', agent: 'drafter' });

  const userMsg =
    `Draft the MFR for this order:\n${JSON.stringify(rx, null, 2)}\n` +
    `Note: the active ingredient is listed at ${rx.active_quantity_g} g in a ${rx.batch_size_g} g batch.`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }];
  const sections: Partial<Record<MFRSectionName, string>> = {};
  let statedConcentrationPct: string | null = null;

  for (let turn = 0; turn < 12; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt(pack),
      tools: DRAFTER_TOOLS as unknown as Anthropic.Tool[],
      messages,
    });

    for (const block of resp.content) {
      if (block.type === 'text' && block.text) emit({ type: 'text_delta', agent: 'drafter', delta: block.text });
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: resp.content });

    if (toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown>;
      emit({ type: 'tool_call', agent: 'drafter', tool: tu.name, input });
      const t0 = Date.now();
      let output: unknown;
      try {
        output = await dispatchTool(tu.name, input, sandbox);
      } catch (err) {
        output = { error: (err as Error).message };
      }
      emit({ type: 'tool_result', agent: 'drafter', tool: tu.name, output, ms: Date.now() - t0 });

      if (tu.name === 'calculate_formulation' && (output as { concentration_pct?: string }).concentration_pct) {
        statedConcentrationPct = (output as { concentration_pct: string }).concentration_pct;
      }
      if (tu.name === 'fill_mfr_section') {
        const r = output as { section: MFRSectionName; content: string };
        sections[r.section] = r.content;
        emit({ type: 'mfr_section', section: r.section, content: r.content });
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { sections, statedConcentrationPct };
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS.
```bash
git add lib/agents/anthropic-tools.ts lib/agents/anthropic-tools.test.ts lib/agents/drafter.ts
git commit -m "feat: drafter agent with deterministic tool dispatcher"
```

---

## Task 13: Reviewer agent + signoff logic

**Files:**
- Create: `lib/agents/reviewer.ts`
- Test: `lib/agents/reviewer.test.ts`

> The reviewer's Claude loop is independent (fresh client, MFR artifact only). The deterministic part we test is `runSignoff()` — given the prescription + stated + computed values, it produces the reconcile finding and pass/fail, exactly as the route will call it.

- [ ] **Step 1: Write failing tests**

Create `lib/agents/reviewer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runSignoff } from '@/lib/agents/reviewer';
import type { Prescription } from '@/lib/types';

const ketoprofen: Prescription = {
  drug: 'ketoprofen', strength_pct: 5, dosage_form: 'gel', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 0.5,
};
const hydrocortisone: Prescription = {
  drug: 'hydrocortisone', strength_pct: 1, dosage_form: 'cream', batch_size_g: 100,
  preserved: false, aw_class: 'aqueous', active_quantity_g: 1.0,
};

describe('runSignoff', () => {
  it('ketoprofen 10x underdose → FAILED with stated_vs_prescribed', () => {
    const r = runSignoff(ketoprofen, { computedPct: '0.5000', statedPct: '0.5' });
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.invariant === 'stated_vs_prescribed')).toBe(true);
  });

  it('hydrocortisone clean → PASSED', () => {
    const r = runSignoff(hydrocortisone, { computedPct: '1.0000', statedPct: '1.0' });
    expect(r.passed).toBe(true);
    expect(r.findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  it('re-runs compliance and adds an error finding if ineligible at review time', () => {
    const r = runSignoff(
      { ...hydrocortisone, drug: 'estriol' },
      { computedPct: '1.0000', statedPct: '1.0', now: new Date('2026-05-31T12:00:00Z').getTime(), demoOffline: true },
    );
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.field.toLowerCase().includes('compliance'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/agents/reviewer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reviewer + signoff**

Create `lib/agents/reviewer.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { REVIEWER_TOOLS, dispatchTool } from '@/lib/agents/anthropic-tools';
import { reconcile } from '@/lib/tools/qa-checker';
import { checkCompliance } from '@/lib/tools/compliance-gate';
import type { SandboxRunner } from '@/lib/tools/calculator';
import type { Prescription, ReferencePack, StreamEvent, QAFinding } from '@/lib/types';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export interface SignoffInput {
  computedPct: string; // reviewer's independent recompute (e.g. "0.5000")
  statedPct: string;   // concentration recorded in the MFR (e.g. "0.5")
  now?: number;
  demoOffline?: boolean;
}

export interface SignoffResult {
  passed: boolean;
  findings: QAFinding[];
  summary: string;
}

/** Deterministic sign-off: reconcile() + compliance re-check. Never a model decision. */
export function runSignoff(rx: Prescription, input: SignoffInput): SignoffResult {
  const findings: QAFinding[] = [];

  findings.push(
    reconcile({
      ingredient: rx.drug,
      prescribed: `${rx.strength_pct}%`,
      stated: `${input.statedPct}%`,
      computed: `${input.computedPct}%`,
    }),
  );

  const compliance = checkCompliance(rx.drug, { now: input.now, demoOffline: input.demoOffline });
  if (!compliance.eligible) {
    findings.push({
      severity: 'error',
      field: `${rx.drug} compliance`,
      invariant: 'ok',
      message: `Compliance re-check at review time: ${compliance.reason ?? compliance.status}`,
    });
  }

  const passed = findings.every((f) => f.severity !== 'error');
  const summary = passed
    ? 'All concentration checks passed; formulation matches the order.'
    : findings.find((f) => f.severity === 'error')?.message ?? 'Review failed.';
  return { passed, findings, summary };
}

/**
 * Independent reviewer agent: a brand-new Anthropic call that sees only the MFR
 * artifact + prescription + reference pack and re-runs the math via tools.
 * Returns the reviewer's independently computed concentration string.
 */
export async function runReviewer(
  rx: Prescription,
  mfrArtifact: string,
  pack: ReferencePack,
  emit: (e: StreamEvent) => void,
  sandbox?: SandboxRunner,
): Promise<{ computedPct: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  emit({ type: 'agent_start', agent: 'reviewer' });

  const system = [
    'You are an INDEPENDENT QA reviewer for a compounding record. You did not draft it.',
    'Re-compute the active ingredient concentration yourself using calculate_formulation',
    'from the ingredient weights stated in the MFR. Do not trust the stated concentration.',
    `Reference pack: ${JSON.stringify({ stability: pack.stability, bud_rationale: pack.bud_rationale })}`,
  ].join('\n');

  const userMsg =
    `Original order: ${rx.drug} ${rx.strength_pct}% ${rx.dosage_form}, batch ${rx.batch_size_g} g.\n` +
    `MFR artifact to review:\n${mfrArtifact}\n` +
    'Recompute the active ingredient concentration from its listed weight and the batch size.';

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }];
  let computedPct = '';

  for (let turn = 0; turn < 8; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: REVIEWER_TOOLS as unknown as Anthropic.Tool[],
      messages,
    });
    for (const block of resp.content) {
      if (block.type === 'text' && block.text) emit({ type: 'text_delta', agent: 'reviewer', delta: block.text });
    }
    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: resp.content });
    if (toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown>;
      emit({ type: 'tool_call', agent: 'reviewer', tool: tu.name, input });
      const t0 = Date.now();
      let output: unknown;
      try {
        output = await dispatchTool(tu.name, input, sandbox);
      } catch (err) {
        output = { error: (err as Error).message };
      }
      emit({ type: 'tool_result', agent: 'reviewer', tool: tu.name, output, ms: Date.now() - t0 });
      if (tu.name === 'calculate_formulation' && (output as { concentration_pct?: string }).concentration_pct) {
        computedPct = (output as { concentration_pct: string }).concentration_pct;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Fallback: if the model failed to call the tool, compute deterministically so sign-off still runs.
  if (!computedPct) {
    const { calculateConcentration } = await import('@/lib/tools/calculator');
    const r = await calculateConcentration(
      { ingredient: rx.drug, grams: rx.active_quantity_g, totalGrams: rx.batch_size_g },
      sandbox,
    );
    computedPct = r.concentration_pct;
  }
  return { computedPct };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/agents/reviewer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/reviewer.ts lib/agents/reviewer.test.ts
git commit -m "feat: independent reviewer agent + deterministic sign-off"
```

---

## Task 14: Demo scenarios + fallback events

**Files:**
- Create: `lib/demo/scenarios.ts`
- Create: `lib/demo/fallback-events.ts`
- Test: `lib/demo/scenarios.test.ts`

- [ ] **Step 1: Write failing test**

Create `lib/demo/scenarios.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '@/lib/demo/scenarios';

describe('SCENARIOS', () => {
  it('hydrocortisone is a clean pass (stated weight == correct weight)', () => {
    const s = SCENARIOS.find((x) => x.id === 'hydrocortisone')!;
    expect(s.prescription.active_quantity_g).toBe(1.0);
    expect(s.prescription.strength_pct).toBe(1);
  });
  it('ketoprofen plants a 10x decimal slip (0.5 g instead of 5 g)', () => {
    const s = SCENARIOS.find((x) => x.id === 'ketoprofen')!;
    expect(s.prescription.active_quantity_g).toBe(0.5);
    expect(s.prescription.strength_pct).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/demo/scenarios.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scenarios**

Create `lib/demo/scenarios.ts`:
```ts
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
```

Create `lib/demo/fallback-events.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/demo/scenarios.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/demo/scenarios.ts lib/demo/fallback-events.ts lib/demo/scenarios.test.ts
git commit -m "feat: demo scenarios and offline fallback event sequence"
```

---

## Task 15: SSE route — orchestration

**Files:**
- Create: `app/api/generate/route.ts`

> Next.js 16 App Router route handler. Returns a `ReadableStream` as `text/event-stream`. The compliance gate is the hard first step; when `eligible: false` the stream emits the result and closes with no agent calls. Audit persistence is awaited (status surfaced) before `done`. There is no pure-unit test for the route itself — it is verified manually in Task 18; the orchestration logic it calls (gate, drafter dispatcher, sign-off, persist) is already unit-tested.

- [ ] **Step 1: Implement the route**

Create `app/api/generate/route.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { checkCompliance } from '@/lib/tools/compliance-gate';
import { buildReferencePack } from '@/lib/agents/reference-pack';
import { runDrafter } from '@/lib/agents/drafter';
import { runReviewer, runSignoff } from '@/lib/agents/reviewer';
import { persistRun } from '@/lib/integrations/insforge';
import { createCalcSandbox } from '@/lib/integrations/daytona';
import { FALLBACK_EVENTS } from '@/lib/demo/fallback-events';
import type { Prescription, StreamEvent, AuditEvent, AuditRun, MFRSectionName } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isFallback = url.searchParams.get('fallback') === 'true';
  const body = (await req.json().catch(() => ({}))) as { prescription?: Prescription };
  const rx = body.prescription;

  const encoder = new TextEncoder();
  const startedAt = new Date().toISOString();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const events: AuditEvent[] = [];
      const emit = (e: StreamEvent) => {
        controller.enqueue(encoder.encode(sse(e)));
        const agent = 'agent' in e ? (e as { agent?: AuditEvent['agent'] }).agent : null;
        events.push({ ...e, agent: agent ?? null, ts: new Date().toISOString() });
      };

      try {
        // Offline demo: replay recorded events with small delays, no network.
        if (isFallback) {
          for (const e of FALLBACK_EVENTS) {
            emit(e);
            await new Promise((r) => setTimeout(r, 350));
          }
          controller.close();
          return;
        }

        if (!rx) {
          emit({ type: 'error', message: 'Missing prescription in request body.' });
          controller.close();
          return;
        }

        // Step 0: Compliance gate (fail-closed).
        const compliance = checkCompliance(rx.drug);
        emit({
          type: 'compliance_result',
          eligible: compliance.eligible,
          drug: compliance.drug,
          reason: compliance.reason,
          status: compliance.status,
          source: compliance.source,
        });
        if (!compliance.eligible) {
          emit({ type: 'done' });
          controller.close();
          return;
        }

        // Optional shared sandbox.
        const sandbox = await createCalcSandbox();
        const runId = randomUUID();

        try {
          const pack = buildReferencePack(rx);

          // Phase 1: Drafter.
          const draft = await runDrafter(rx, pack, emit, sandbox ?? undefined);

          // Phase 2: Reviewer (independent recompute) + deterministic sign-off.
          const mfrArtifact = Object.entries(draft.sections)
            .map(([k, v]) => `## ${k}\n${v}`)
            .join('\n\n');
          const { computedPct } = await runReviewer(rx, mfrArtifact, pack, emit, sandbox ?? undefined);

          const statedPct = draft.statedConcentrationPct ?? computedPct;
          const signoff = runSignoff(rx, { computedPct, statedPct });
          for (const f of signoff.findings) emit({ type: 'qa_finding', ...f });
          emit({ type: 'qa_signoff', passed: signoff.passed, summary: signoff.summary });

          // Audit: awaited before done, status surfaced.
          emit({ type: 'audit_status', run_id: runId, state: 'pending' });
          const finishedAt = new Date().toISOString();
          const auditRun: AuditRun = {
            id: runId, formula: rx,
            mfr: draft.sections as Record<MFRSectionName, string>,
            bud: null, passed: signoff.passed,
            startedAt, finishedAt, events,
          };
          const persisted = await persistRun(auditRun);
          emit({
            type: 'audit_status', run_id: runId, state: persisted,
            detail: persisted === 'failed' ? 'Audit trail not durably saved — record is NOT signed off' : undefined,
          });
        } finally {
          if (sandbox) await sandbox.destroy();
        }

        emit({ type: 'done' });
        controller.close();
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS. (If `next build` fails on `@insforge/sdk`/`@daytona/sdk` because the optional packages are not installed, confirm those imports are dynamic `await import(...)` only — they are — so the build does not statically resolve them. If a static-analysis error still appears, add the package name to `serverExternalPackages` in `next.config.ts`: `const nextConfig = { serverExternalPackages: ['@insforge/sdk', '@daytona/sdk'] }`.)

- [ ] **Step 3: Commit**

```bash
git add app/api/generate/route.ts next.config.ts
git commit -m "feat: SSE orchestration route with fail-closed gate and awaited audit"
```

---

## Task 16: Frontend — components

**Files:**
- Create: `components/FormulaInput.tsx`
- Create: `components/WorkPanel.tsx`
- Create: `components/MFRDocument.tsx`
- Create: `components/QASignoffPanel.tsx`

> These are presentational client components driven by props. No unit tests (out of demo test scope per spec); verified visually in Task 18.

- [ ] **Step 1: FormulaInput**

Create `components/FormulaInput.tsx`:
```tsx
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
```

- [ ] **Step 2: WorkPanel**

Create `components/WorkPanel.tsx`:
```tsx
'use client';
import type { StreamEvent } from '@/lib/types';

export function WorkPanel({ events }: { events: StreamEvent[] }) {
  const rows = events.filter(
    (e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'agent_start' || e.type === 'sandbox_exec',
  );
  return (
    <div className="flex flex-col gap-1 font-mono text-xs">
      <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-gray-500">Live Agent Work</h2>
      {rows.map((e, i) => {
        if (e.type === 'agent_start') return <div key={i} className="mt-2 font-semibold text-blue-700">▸ {e.agent}</div>;
        if (e.type === 'tool_call') return <div key={i} className="text-gray-700">→ {e.tool}({JSON.stringify(e.input)})</div>;
        if (e.type === 'tool_result') return <div key={i} className="text-green-700">  ✓ {e.tool} ({e.ms}ms)</div>;
        if (e.type === 'sandbox_exec') return <div key={i} className="text-purple-700">  ⧉ sandbox {e.sandbox_id}</div>;
        return null;
      })}
    </div>
  );
}
```

- [ ] **Step 3: MFRDocument**

Create `components/MFRDocument.tsx`:
```tsx
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
```

- [ ] **Step 4: QASignoffPanel**

Create `components/QASignoffPanel.tsx`:
```tsx
'use client';
import type { StreamEvent, QAFinding, ComplianceSource } from '@/lib/types';

export function QASignoffPanel({
  findings, signoff, compliance, audit,
}: {
  findings: QAFinding[];
  signoff: { passed: boolean; summary: string } | null;
  compliance: { status: string; source: ComplianceSource; reason?: string } | null;
  audit: { state: string; detail?: string } | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">QA Sign-Off</h2>

      {compliance && (
        <div className="rounded border p-2 text-xs">
          <div className="font-semibold">Compliance: {compliance.status}</div>
          <div className="text-gray-500">
            source: {compliance.source.origin} · {compliance.source.fetched_at ?? 'unknown date'} ·
            {compliance.source.stale ? ' STALE' : ' fresh'}
          </div>
          {compliance.reason && <div className="text-red-700">{compliance.reason}</div>}
        </div>
      )}

      {findings.map((f, i) => (
        <div key={i} className={f.severity === 'error' ? 'text-red-700 text-sm' : 'text-green-700 text-sm'}>
          {f.severity === 'error' ? '✗' : '✓'} {f.message}
        </div>
      ))}

      {signoff && (
        <div className={`rounded p-2 text-sm font-bold ${signoff.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {signoff.passed ? '● PASSED' : '● FAILED — Hold'}: {signoff.summary}
        </div>
      )}

      {audit && (
        <div className={`text-xs ${audit.state === 'written' ? 'text-gray-500' : 'text-amber-700'}`}>
          Audit: {audit.state}{audit.detail ? ` — ${audit.detail}` : ''}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS.
```bash
git add components/
git commit -m "feat: UI components for input, work feed, MFR, and QA sign-off"
```

---

## Task 17: Main page — SSE client wiring

**Files:**
- Modify: `app/page.tsx` (replace the scaffold)

- [ ] **Step 1: Implement the page**

Replace `app/page.tsx` entirely with:
```tsx
'use client';
import { useState } from 'react';
import { FormulaInput } from '@/components/FormulaInput';
import { WorkPanel } from '@/components/WorkPanel';
import { MFRDocument } from '@/components/MFRDocument';
import { QASignoffPanel } from '@/components/QASignoffPanel';
import type { StreamEvent, Prescription, QAFinding, MFRSectionName, ComplianceSource } from '@/lib/types';

export default function Home() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [sections, setSections] = useState<Partial<Record<MFRSectionName, string>>>({});
  const [findings, setFindings] = useState<QAFinding[]>([]);
  const [signoff, setSignoff] = useState<{ passed: boolean; summary: string } | null>(null);
  const [compliance, setCompliance] = useState<{ status: string; source: ComplianceSource; reason?: string } | null>(null);
  const [audit, setAudit] = useState<{ state: string; detail?: string } | null>(null);
  const [running, setRunning] = useState(false);

  async function run(rx: Prescription) {
    setEvents([]); setSections({}); setFindings([]); setSignoff(null); setCompliance(null); setAudit(null);
    setRunning(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescription: rx }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const e = JSON.parse(line.slice(5).trim()) as StreamEvent;
          setEvents((prev) => [...prev, e]);
          if (e.type === 'mfr_section') setSections((p) => ({ ...p, [e.section]: e.content }));
          if (e.type === 'qa_finding') setFindings((p) => [...p, e]);
          if (e.type === 'qa_signoff') setSignoff({ passed: e.passed, summary: e.summary });
          if (e.type === 'compliance_result') setCompliance({ status: e.status, source: e.source, reason: e.reason });
          if (e.type === 'audit_status') setAudit({ state: e.state, detail: e.detail });
        }
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-6 md:grid-cols-2">
      <header className="md:col-span-2 border-b pb-3 text-lg font-bold">
        SYNTHA <span className="font-normal text-gray-500">| Formulation &amp; BUD Copilot</span>
      </header>
      <section className="rounded border p-4"><FormulaInput onRun={run} disabled={running} /></section>
      <section className="rounded border p-4"><WorkPanel events={events} /></section>
      <section className="rounded border p-4"><MFRDocument sections={sections} /></section>
      <section className="rounded border p-4">
        <QASignoffPanel findings={findings} signoff={signoff} compliance={compliance} audit={audit} />
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: main page wiring SSE stream to UI panels"
```

---

## Task 18: Cache-refresh script + full verification

**Files:**
- Create: `scripts/refresh-regulatory-cache.ts`
- Create: `.env.example`

- [ ] **Step 1: Implement the refresh script**

Create `scripts/refresh-regulatory-cache.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callRtrvr } from '@/lib/integrations/rtrvr';

async function main() {
  const cacheDir = join(process.cwd(), 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const now = new Date().toISOString();

  const reg = await callRtrvr('Summarize USP <795> (Nov 1, 2023) BUD rules by water-activity class and preservation.', [
    'https://www.usp.org/',
  ]);
  writeFileSync(
    join(cacheDir, 'regulatory.json'),
    JSON.stringify({ fetched_at: now, source: 'rtrvr.ai / USP <795> (Nov 1, 2023)', rationale_text: String(reg) }, null, 2),
  );

  const fda = (await callRtrvr('List FDA 503A difficult-to-compound bulk drugs and drugs withdrawn for safety.', [
    'https://www.fda.gov/',
  ])) as { ineligible?: { name: string; reason: string }[] };
  writeFileSync(
    join(cacheDir, 'fda-list.json'),
    JSON.stringify({ fetched_at: now, source: 'rtrvr.ai / FDA 503A Bulks List', ineligible: fda.ineligible ?? [] }, null, 2),
  );

  console.log('Wrote cache/regulatory.json and cache/fda-list.json at', now);
}

main().catch((err) => {
  console.error('[refresh-regulatory-cache] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create `.env.example`**

Create `.env.example`:
```bash
ANTHROPIC_API_KEY=                  # Required
ANTHROPIC_MODEL=                    # Optional — defaults to claude-sonnet-4-6
DAYTONA_API_KEY=                    # Optional — falls back to in-process math
DAYTONA_SERVER_URL=                 # Optional — defaults to https://app.daytona.io/api
INSFORGE_BASE_URL=                  # Optional — enables audit trail
INSFORGE_ANON_KEY=                  # Optional — anon key from InsForge dashboard
RTRVR_API_KEY=                      # Optional — only needed to run refresh-regulatory-cache.ts
DEMO_OFFLINE_MODE=                  # Optional — set true ONLY to allow eligibility passes against the static fallback list
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green (bud-engine, calculator, qa-checker, compliance-gate, stability-db, reference-pack, mfr-builder, insforge, anthropic-tools, reviewer, scenarios).

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: PASS (compiles, route + page included).

- [ ] **Step 5: Manual end-to-end verification**

Run: `npm run dev`, open `http://localhost:3000`, and confirm with `ANTHROPIC_API_KEY` set and `DEMO_OFFLINE_MODE=true` (no FDA cache present):
  1. **Hydrocortisone** → MFR builds, BUD shows **14 days refrigerated** with a USP `<795>` citation, QA sign-off **PASSED**, compliance badge shows `static_fallback · STALE` (because offline mode). 
  2. **Ketoprofen** → QA sign-off **FAILED** with "formulation does not match the order" (0.5% ≠ 5%).
  3. **Estriol** → `compliance_result { status: 'ineligible' }`, stream closes, **no MFR drafted**.
  4. With `DEMO_OFFLINE_MODE` unset and no cache → Hydrocortisone now returns `status: 'unverifiable'` and **blocks** (fail-closed verified).
  5. Offline replay: `curl -N -X POST 'http://localhost:3000/api/generate?fallback=true'` streams the recorded ketoprofen failure with delays.

Record the observed result of each in the commit message.

- [ ] **Step 6: Commit**

```bash
git add scripts/refresh-regulatory-cache.ts .env.example
git commit -m "feat: regulatory cache refresh script, env example, and verified e2e demo"
```

---

## Self-Review (completed against the spec)

**Spec coverage:**
- Compliance gate (fail-closed, provenance, demo-offline) → Tasks 6, 15, 16 ✓
- BUD engine (Nov-2023 rules, min-with-stability, regression for aqueous demos) → Task 3 ✓
- Three-way reconcile (computed/stated/prescribed invariants) → Task 5 ✓
- decimal.js calculator (sandbox-aware) → Task 4 ✓
- Reference pack (single-entry scoping) → Task 8 ✓
- Drafter + reviewer independence (separate Anthropic call, MFR-artifact-only input) → Tasks 12, 13 ✓
- Atomic idempotent audit (RPC, run_id key, awaited before done, status surfaced) → Tasks 10, 15 ✓
- Typed event stream (matches revised spec including `compliance_result.status/source` and `audit_status`) → Task 2 ✓
- Daytona/Rtrvr optional integrations + cache reader split (fail-open rationale vs fail-closed FDA) → Tasks 7, 11, 18 ✓
- Demo scenarios A/B/C + offline fallback → Tasks 14, 15 ✓
- Frontend layout (4 panels) + provenance/audit badges → Tasks 16, 17 ✓
- Migrations 001–003 → Task 10 ✓
- MFR sections (7, in order) → Task 9 ✓

**Out of scope (per spec):** USP 797, server-side PDF, auth, formula-history UI, live Rtrvr on request path, persistent sandboxes — none planned. ✓

**Placeholder scan:** No `TODO`/`handle edge cases`/"similar to Task N" — every code step contains complete code. ✓

**Type consistency:** `StreamEvent`, `ComplianceResult`, `QAFinding`, `BudResult`, `Prescription`, `AuditRun` defined once in Task 2 and used verbatim downstream. Tool names (`compute_bud`, `calculate_formulation`, `fill_mfr_section`, `lookup_stability`, `resolve_drug`) consistent across dispatcher, schemas, drafter, and reviewer. `persist_run` RPC name matches between migration 003 and `insforge.ts`. ✓

**Known build caveat documented:** optional SDKs are dynamically imported; `serverExternalPackages` fallback noted in Task 15 if static analysis trips.
