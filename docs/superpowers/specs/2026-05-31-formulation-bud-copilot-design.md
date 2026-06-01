# Syntha — Formulation & BUD Copilot: Design Spec

**Date:** 2026-05-31  
**Status:** Design proposal — **not yet implemented**. Sponsor integrations, three-way checker, USP 795 Nov 2023 BUD logic, and reference pack are specified below but not present in the codebase. The repository currently contains this spec plus a default Next.js scaffold; none of the `lib/`, `data/`, or test files described here exist yet. Treat every "the engine does X" / "has tests" statement as a design requirement to be built and verified — not an existing guarantee.  
**Scope:** USP 795 non-sterile compounding only

---

## Problem & Goal

Pharmacy compounders spend significant time drafting Master Formulation Records (MFRs) by hand, and calculation errors — especially decimal slips — are the leading cause of compounding incidents. Syntha demonstrates that a dual-agent AI system, grounded in deterministic tools, can produce a near-submission-ready MFR with a BUD in under a minute, and that an independent reviewer agent can reliably catch realistic errors.

The demo story: enter a compound formula, watch the drafter agent build the record live, then watch an independent reviewer re-run the math and catch a 10× concentration error — every single run, because the check is deterministic code, not a model guess.

---

## Architecture

### Orchestration Model

Single Next.js app, single streaming API route. No Python sidecar, no second service.

```
POST /api/generate
  ↓
Step 0: Compliance gate  — deterministic code checks drug against FDA difficult-to-compound list
                            FAILS CLOSED: if the FDA list cannot be confirmed fresh-and-authoritative,
                            the request is blocked, not passed; hard-stop if ineligible OR unverifiable;
                            never reaches agents
  ↓
Phase 1: Drafter agent   — Claude call #1 + reference pack; tool loop; emits mfr_section events
Phase 2: Reviewer agent  — Claude call #2; receives MFR artifact + prescription + reference pack (NOT drafter context)
                            re-runs math via tool calls; app code calls reconcile() and emits qa_finding
  ↓
When audit enabled: persistRun() runs BEFORE 'done' — writes atomically, emits audit_status
SSE stream closes → client renders final document + QA panel + audit state
```

**Independence contract:** The reviewer is a brand-new `anthropic.messages.create()` call. It receives only the serialised MFR artifact (sections + stated values), the original prescription (ordered strength), and a formula-scoped reference pack — no drafter messages, no drafter tool results, no drafter reasoning. It re-runs all math with its own tool calls. The deterministic three-way reconciliation (`reconcile()`) runs in app code after the reviewer's tool loop completes; the model never decides whether numbers match.

**Reference pack (scoped retrieval):** Both agents receive a compact, formula-scoped reference pack assembled before each agent call. It contains exactly: the single matching formulary entry, the single applicable BUD rule (as rationale text — the engine does the actual calculation), the single matching stability entry, and the compliance gate result. No full corpus is ever injected into a prompt.

**Runtime:** Demo from `localhost` (`npm run dev`). Avoids all serverless timeout concerns from two sequential tool-use loops.

---

## File Structure

```
app/
  page.tsx                          # Main UI (single page)
  api/generate/route.ts             # Streaming SSE endpoint

lib/
  agents/
    drafter.ts                      # Drafter: Claude call #1, receives reference pack
    reviewer.ts                     # Reviewer: Claude call #2, receives MFR artifact + reference pack
    reference-pack.ts               # Assembles formula-scoped reference pack for each agent
  tools/
    drug-resolver.ts                # openFDA /drug/label.json REST call
    calculator.ts                   # decimal.js: quantities, concentrations (sandbox-aware)
    stability-db.ts                 # stability.json lookup; getRegulatoryRules() reads cache
    bud-engine.ts                   # USP 795 Nov 2023 rules engine (driven by bud_rules.json)
    mfr-builder.ts                  # Structured MFR section assembler
    qa-checker.ts                   # reconcile(prescribed, stated, computed) — three-way check
    compliance-gate.ts              # FDA difficult-to-compound check; hard-stop if ineligible
  integrations/
    daytona.ts                      # Sandbox lifecycle: create, codeRun wrapper, delete
    insforge.ts                     # InsForge client + persistRun() atomic idempotent RPC
    rtrvr.ts                        # Rtrvr API calls + cache normalizer (script use only)
  data/
    bud_rules.json                  # ~20–30 rules: form_class × aw_class × preserved → days + citation
    formulary.json                  # Structured standard formulas for demo compounds (own words, no copyrighted prose)
    stability.json                  # ~12 ingredients, real values + provenance (static fallback)
    fda-compliance-fallback.json    # Short static FDA difficult-to-compound / withdrawn-for-safety list
  demo/
    scenarios.ts                    # Pre-wired hydrocortisone + ketoprofen inputs
    fallback-events.ts              # Pre-recorded event sequence for offline fallback
  types/
    index.ts                        # All shared TypeScript types

components/
  FormulaInput.tsx                  # Structured form + demo scenario buttons
  WorkPanel.tsx                     # Live tool-call feed (both agents)
  MFRDocument.tsx                   # Rendered MFR sections
  QASignoffPanel.tsx                # Findings list + pass/fail badge

scripts/
  refresh-regulatory-cache.ts       # Standalone: calls Rtrvr for USP guidance + FDA list; writes cache/

migrations/
  001_mfr_runs.sql
  002_agent_decisions.sql
  003_persist_run_fn.sql            # Atomic, idempotent persist_run(p_run, p_decisions) RPC

cache/                              # Runtime-only, gitignored
  regulatory.json                   # Rtrvr-fetched USP BUD guidance, normalized
  fda-list.json                     # Rtrvr-fetched FDA difficult-to-compound list, normalized
```

---

## Typed Event Stream

Every SSE message is a JSON-encoded `StreamEvent`. The UI reacts to each type independently.

```typescript
type StreamEvent =
  | { type: 'compliance_result'; eligible: boolean; drug: string; reason?: string;
                                  status: 'eligible' | 'ineligible' | 'unverifiable';
                                  source: { origin: 'fda_cache' | 'static_fallback'; fetched_at: string | null; stale: boolean } }
  | { type: 'agent_start';    agent: 'drafter' | 'reviewer' }
  | { type: 'tool_call';      tool: string; input: unknown }
  | { type: 'tool_result';    tool: string; output: unknown; ms: number }
  | { type: 'sandbox_exec';   code: string; sandbox_id: string }
  | { type: 'sandbox_result'; result: string; exit_code: number; ms: number }
  | { type: 'text_delta';     delta: string }
  | { type: 'mfr_section';    section: MFRSectionName; content: string }
  | { type: 'qa_finding';     severity: 'pass' | 'error' | 'warning';
                               field: string;
                               prescribed?: string; stated?: string; computed?: string;
                               invariant: 'computed_vs_stated' | 'stated_vs_prescribed' | 'computed_vs_prescribed' | 'ok';
                               message: string }
  | { type: 'qa_signoff';     passed: boolean; summary: string }
  | { type: 'audit_status';   run_id: string; state: 'pending' | 'written' | 'failed'; detail?: string }
  | { type: 'done' }
  | { type: 'error';          message: string }
```

- `compliance_result`: emitted before any agent runs. The stream closes with no MFR attempt whenever `eligible` is `false` — and `eligible` is `false` for **both** `status: 'ineligible'` (drug is on the list) and `status: 'unverifiable'` (the list could not be confirmed fresh-and-authoritative). Only `status: 'eligible'` proceeds. The `source` object (origin, `fetched_at`, `stale`) MUST be surfaced in the UI so the operator can see exactly which list backed the decision and how old it is — a pass on a stale static fallback is never shown as equivalent to a pass on a fresh official list.
- `mfr_section`: populates the document panel as sections arrive.
- `qa_finding`: `invariant` field names exactly which of the three-way checks failed (see Reviewer Agent section). Emitted by app code, not the model.
- `sandbox_exec`/`sandbox_result`: make isolated math visible in the work panel.
- `audit_status`: reports the durable-write outcome. When audit is enabled, the run is **not** reported as fully complete until this resolves to `written` or `failed` (see Insforge section). `failed` is surfaced to the operator, not just logged — a compounding QA record with no audit trail must be visible, never silent.

---

## Drafter Agent Tools

| Tool | Source | Notes |
|---|---|---|
| `resolve_drug` | openFDA `/drug/label.json` | One live API call; real credibility |
| `calculate_formulation` | `decimal.js` in Daytona sandbox | Quantities, concentrations — no floats, isolated execution |
| `lookup_stability` | `stability.json` | Real USP/literature values, provenance noted |
| `compute_bud` | `bud-engine.ts` driven by `bud_rules.json` | Deterministic; code, not model judgment |
| `fill_mfr_section` | Template assembler | Returns `{ section, content }`, emits `mfr_section` event |

The drafter's system prompt includes the formula-scoped **reference pack** (assembled by `reference-pack.ts`) — the single matching formulary entry, the single applicable BUD rule rationale, the single matching stability entry, and the compliance gate result. No other reference data is injected.

### USP 795 BUD Rules Engine (Nov 1, 2023 revision)

The engine is driven by `data/bud_rules.json` — never by LLM reasoning. The two key classification axes are **water activity class** (`aw ≥ 0.60` = aqueous; `aw < 0.60` = nonaqueous) and **preservation status**.

| Category | aw class | Preserved | Default BUD | Storage |
|---|---|---|---|---|
| Nonpreserved aqueous | ≥ 0.60 | No | **14 days** | Refrigerated |
| Preserved aqueous | ≥ 0.60 | Yes | **35 days** | Controlled room temp or refrigerated |
| Nonaqueous oral liquid | < 0.60 | — | **90 days** | Per stability data |
| Other nonaqueous | < 0.60 | — | **180 days** | Per stability data |

*Aqueous* explicitly covers creams, gels, emulsions, solutions, sprays, suspensions (aw ≥ 0.60). **Both demo formulas are aqueous** — hydrocortisone cream and ketoprofen PLO gel are both aw ≥ 0.60 and must not receive a 180-day BUD.

The engine returns `min(category_default, stability_data.bud_days)` — stability data can only shorten the default, never extend it beyond the category ceiling without explicit extended-stability data. Every output carries a `rule_citation` string identifying the exact `bud_rules.json` entry that fired.

`bud_rules.json` schema:
```json
{
  "rules": [
    {
      "id": "aq-nonpreserved",
      "aw_class": "aqueous",
      "preserved": false,
      "default_days": 14,
      "storage": "refrigerated",
      "citation": "USP <795> Table 1 (Nov 1, 2023)",
      "applies_to": ["cream", "gel", "solution", "suspension", "emulsion", "spray", "lotion"]
    }
  ]
}
```

**Required before this design can be marked implemented:** the BUD engine must ship with `data/bud_rules.json`, `lib/tools/bud-engine.ts`, and a unit-test file covering every branch — explicitly including a regression test asserting that both demo formulas (aqueous hydrocortisone cream and aqueous ketoprofen PLO gel, `aw ≥ 0.60`) resolve to the 14-day aqueous BUD and can never regress to 180 days. Until those files and passing tests exist in the tree, this is an unverified invariant, not a guarantee.

---

## Reviewer Agent

**Input (user message only):** serialised MFR artifact (sections + stated ingredient quantities and concentrations) + original prescription (ordered drug name, strength, dosage form, batch size) + formula-scoped reference pack. Nothing from the drafter's context or reasoning.

**Tools available:** `calculate_formulation`, `compute_bud` (same implementations the Drafter used; independent execution)

After the reviewer's tool loop completes, **app code** calls `reconcile()` with the three values and emits `qa_finding` events. The model never decides whether numbers match.

### Three-Way Reconciliation (Fix #1)

There are three distinct values for every active ingredient:
- **prescribed**: the ordered strength from the prescription (e.g. `5%`)
- **stated**: the concentration recorded in the MFR (derived from the drafter's stated quantities)
- **computed**: concentration independently recalculated by the reviewer from the MFR's listed ingredient weights (runs in Daytona sandbox)

```typescript
// lib/tools/qa-checker.ts
interface ReconcileInput {
  ingredient: string;
  prescribed: string;   // e.g. "5%"  — from prescription
  stated:     string;   // e.g. "0.5%" — from MFR stated values
  computed:   string;   // e.g. "0.5%" — reviewer's independent recalculation
}

interface QAFinding {
  severity:   'pass' | 'error' | 'warning';
  field:      string;
  prescribed?: string;
  stated?:    string;
  computed?:  string;
  invariant:  'computed_vs_stated' | 'stated_vs_prescribed' | 'computed_vs_prescribed' | 'ok';
  message:    string;
}

function reconcile(input: ReconcileInput): QAFinding {
  const p = new Decimal(input.prescribed.replace('%', ''));
  const s = new Decimal(input.stated.replace('%', ''));
  const c = new Decimal(input.computed.replace('%', ''));

  if (!c.equals(s)) {
    // Arithmetic or transcription error: stated quantity doesn't produce stated concentration
    return {
      severity: 'error', field: `${input.ingredient} concentration`,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'computed_vs_stated',
      message: `Computed ${input.computed} ≠ stated ${input.stated} — arithmetic or transcription error`,
    };
  }
  if (!s.equals(p)) {
    // Formulation doesn't match the order — the MFR is internally consistent but wrong
    return {
      severity: 'error', field: `${input.ingredient} concentration`,
      prescribed: input.prescribed, stated: input.stated, computed: input.computed,
      invariant: 'stated_vs_prescribed',
      message: `Stated/computed ${input.stated} ≠ prescribed ${input.prescribed} — formulation does not match the order`,
    };
  }
  return {
    severity: 'pass', field: `${input.ingredient} concentration`,
    invariant: 'ok',
    message: `${input.ingredient} concentration verified: prescribed = stated = computed = ${input.stated}`,
  };
}
```

**Why two separate checks matter for the ketoprofen demo:**
The MFR lists 0.5 g of ketoprofen in a 100 g batch. The reviewer's sandbox recomputes: 0.5 g ÷ 100 g = 0.5% = stated 0.5%. So `computed_vs_stated` passes — the record is internally consistent. But the prescription ordered 5%. `stated_vs_prescribed` fails: 0.5% ≠ 5%. The `invariant` field in the emitted `qa_finding` tells the operator exactly what went wrong: *"formulation does not match the order"* — a 10× underdose.

**Rejection rules (hard errors before reconcile):**
- Missing prescribed, stated, or computed value → `error`, invariant `'computed_vs_stated'`
- Unit mismatch (e.g. `%` vs `mg/mL` without conversion) → `error` with explanation

**Compliance re-check:** The reviewer also re-runs the compliance gate against the MFR's stated active ingredient. If the gate fires at review time (e.g. drug name was resolved differently), it emits an additional `qa_finding` with severity `error`.

---

## Demo Scenarios

### Scenario A — Hydrocortisone 1% Cream (clean pass)

- **Input:** Prescribed 1%, HC 1.0 g, cream base q.s. 100 g, nonpreserved, aqueous semisolid
- **Compliance gate:** HC is not on FDA difficult-to-compound list → eligible ✓
- **BUD:** Category = nonpreserved aqueous → **14 days refrigerated** per USP `<795>` Table 1 (Nov 2023)
- **Reviewer reconcile:** computed = 1.0 g ÷ 100 g = 1.0% = stated 1.0% = prescribed 1% → all three match, invariant `ok`
- **Outcome:** QA sign-off PASSED

### Scenario B — Ketoprofen 5% PLO Gel (planted decimal error)

- **Input:** Prescribed 5% / 100 g batch; MFR ingredient weight listed as **0.5 g** (should be 5.0 g — a tenfold decimal slip)
- **Compliance gate:** Ketoprofen is not on FDA list → eligible ✓
- **BUD:** Category = nonpreserved aqueous (PLO gel, aw ≥ 0.60) → **14 days refrigerated**
- **Drafter:** Creates MFR faithfully from the provided (wrong) quantities; states ketoprofen 0.5 g, derived concentration 0.5%
- **Reviewer reconcile:**
  - computed = 0.5 g ÷ 100 g = 0.5%
  - `computed_vs_stated`: 0.5% = stated 0.5% → **passes** (the record is internally consistent)
  - `stated_vs_prescribed`: 0.5% ≠ prescribed 5% → **fails** — invariant `stated_vs_prescribed`
  - Emits `qa_finding` severity `error`: *"Stated/computed 0.5% ≠ prescribed 5% — formulation does not match the order (10× underdose)"*
- **Outcome:** QA sign-off FAILED — cannot proceed

### Scenario C — FDA-list drug (compliance hard-stop)

- **Input:** A drug appearing on the FDA difficult-to-compound list (e.g. a drug withdrawn for safety reasons)
- **Compliance gate fires immediately**, before any agent runs
- Emits `compliance_result { eligible: false, reason: "..." }` and closes the stream
- No MFR is drafted; no audit row is written

All three scenarios are pre-loaded as one-click buttons on the input form. No manual typing during the demo.

---

## Frontend Layout

```
┌─────────────────────────────────────────────────────────────┐
│  SYNTHA  |  Formulation & BUD Copilot                       │
├───────────────────┬─────────────────────────────────────────┤
│  Formula Input    │  Live Agent Work                        │
│                   │  ┌─ Drafter ────────────────────────┐   │
│  [Hydrocortisone] │  │ → resolve_drug(ketoprofen) ✓     │   │
│  [Ketoprofen]     │  │ → calculate_formulation(...) ✓   │   │
│                   │  │ → lookup_stability(...) ✓         │   │
│  Drug: ________   │  │ → compute_bud(...) ✓              │   │
│  Strength: ____   │  └──────────────────────────────────┘   │
│  Form: ________   │  ┌─ QA Reviewer ────────────────────┐   │
│  Qty: _________   │  │ → calculate_formulation(...) ✓   │   │
│                   │  │ → compare_concentrations() ✗      │   │
│  [Generate MFR]   │  │   ⚠ 0.5% ≠ ordered 5%            │   │
│                   │  └──────────────────────────────────┘   │
├───────────────────┴─────────────────────────────────────────┤
│  Master Formulation Record          │  QA Sign-Off          │
│  ─────────────────────────────────  │  ─────────────        │
│  Formula ID: SYN-2026-001           │  ✗ Concentration      │
│  Active: Ketoprofen 5% PLO Gel      │    mismatch           │
│  BUD: [computed] with citation      │                       │
│  [sections build as streamed]       │  ● FAILED — Hold      │
└─────────────────────────────────────────────────────────────┘
```

---

## Reference Data Assets

### `data/stability.json`

~12 common non-sterile compounding ingredients. Drives `lookup_stability` tool and `stability-db.ts`. Provenance field — answer to "is this made up?": *"No, curated subset of real published values."*

```json
{
  "ingredient": "ketoprofen",
  "stability_range_days": 90,
  "optimal_ph": "5.0–6.5",
  "light_sensitive": true,
  "storage": "refrigerated",
  "bud_notes": "Stable in PLO gel base for 90 days at refrigerated temps per Allen LV Jr.",
  "source": "Allen LV Jr. (2012). The Art, Science, and Technology of Pharmaceutical Compounding, 4th ed."
}
```

### `data/bud_rules.json`

~20–30 entries encoding the USP `<795>` Nov 2023 categories. Consumed by the deterministic BUD engine only — never injected as bulk text into a prompt. See BUD Rules Engine section for schema.

### `data/formulary.json`

Structured standard formulas for the two demo compounds. Ingredients, quantities, and procedure steps written in the author's own words — no copyrighted reference-book prose. Consumed by `reference-pack.ts` to retrieve the single matching entry for a given drug/preparation, which is then included in the agent's reference pack.

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
      "procedure_steps": ["Weigh HC on analytical balance.", "Levigate with small amount of base.", "Geometrically incorporate remaining base. Mix until uniform."],
      "aw_class": "aqueous",
      "preserved": false
    }
  ]
}
```

### `data/fda-compliance-fallback.json`

Short static list of drugs on the FDA 503A difficult-to-compound list and drugs withdrawn from the market for safety reasons. **It is a deny-list supplement, not an authoritative source of truth.** A positive match against it always blocks (it can only add known-bad drugs); a "not found" against it does **not** certify eligibility, because it is not guaranteed complete or current. When it is the only data available, the compliance gate returns `status: 'unverifiable'` and fails closed (except in explicit `DEMO_OFFLINE_MODE`). Refresh `cache/fda-list.json` via `scripts/refresh-regulatory-cache.ts` to get an authoritative pass.

```json
{
  "updated": "2026-05-31",
  "source": "FDA 503A Bulks List / Drug Safety Withdrawals (static fallback)",
  "ineligible": [
    { "name": "estriol", "reason": "On FDA 503A difficult-to-compound list" },
    { "name": "bromocriptine", "reason": "Withdrawn for safety — not for compounding" }
  ]
}
```

---

## Sponsor Tool Integrations

### 1. Insforge — Audit Trail

**Package:** `@insforge/sdk`

**Client setup** (`lib/integrations/insforge.ts`):
```typescript
import { createClient } from '@insforge/sdk';

export const insforge = createClient({
  baseUrl: process.env.INSFORGE_BASE_URL!,
  anonKey: process.env.INSFORGE_ANON_KEY!,
});
```

**Schema — two append-only tables (SQL migration files):**

```sql
-- migrations/001_mfr_runs.sql
create table mfr_runs (
  id          uuid primary key default gen_random_uuid(),
  formula     jsonb not null,
  mfr         jsonb,
  bud         jsonb,
  passed      boolean,
  started_at  timestamptz not null,
  finished_at timestamptz
);

-- migrations/002_agent_decisions.sql
create table agent_decisions (
  id       uuid primary key default gen_random_uuid(),
  run_id   uuid not null references mfr_runs(id),
  idx      integer not null,
  agent    text not null,
  kind     text not null,   -- 'tool_call' | 'tool_result' | 'qa_finding' | 'text'
  payload  jsonb not null,
  ts       timestamptz not null default now()
);
```

**Write pattern** — atomic, idempotent, and resolved *before* the run is reported complete (when audit is enabled). The earlier "fire-and-forget after `done`" approach is rejected: it could insert `mfr_runs` but lose `agent_decisions` on a mid-write failure, leaving an audit row with no decision trail and reporting success anyway. Two safeguards fix this:

1. **One transaction, not two sequential inserts.** Both tables are written in a single atomic unit via a server-side RPC (Postgres function) so `mfr_runs` and `agent_decisions` can never diverge — either both land or neither does.
2. **Client-generated idempotency key.** The `run_id` (uuid) is generated up front, before the agents run, and used as the primary key for `mfr_runs`. The RPC is `on conflict do nothing`, so a retry of the same run is safe and never duplicates rows.

```typescript
// run.id is generated at route start (NOT defaulted by the DB), so it is stable
// across retries and already embedded in every streamed event for correlation.
async function persistRun(run: AuditRun): Promise<'written' | 'failed'> {
  const decisions = run.events.map((e, idx) => ({
    run_id: run.id, idx, agent: e.agent, kind: e.type, payload: e, ts: e.ts,
  }));

  // Single atomic RPC: inserts the run row AND all decision rows in one transaction,
  // idempotent on run.id. Defined in migrations/003_persist_run_fn.sql.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await insforge.database.rpc('persist_run', {
        p_run: {
          id: run.id, formula: run.formula, mfr: run.mfr, bud: run.bud,
          passed: run.passed, started_at: run.startedAt, finished_at: run.finishedAt,
        },
        p_decisions: decisions,
      });
      if (error) throw error;
      return 'written';
    } catch (err) {
      console.error(`[insforge] audit write attempt ${attempt} failed:`, err);
      if (attempt === 3) return 'failed';   // surfaced to the operator, not swallowed
    }
  }
  return 'failed';
}
```

**Sequencing in the route (audit enabled):**
```typescript
emit({ type: 'audit_status', run_id: run.id, state: 'pending' });
const result = await persistRun(run);          // awaited BEFORE 'done'
emit({ type: 'audit_status', run_id: run.id, state: result,
       detail: result === 'failed' ? 'Audit trail not durably saved — record is NOT signed off' : undefined });
emit({ type: 'done' });
```

`migrations/003_persist_run_fn.sql` defines `persist_run(p_run jsonb, p_decisions jsonb)` as a `plpgsql` function that does the `mfr_runs` insert (`on conflict (id) do nothing`) and the `agent_decisions` bulk insert inside the implicit function transaction.

**Graceful degradation:** If `INSFORGE_BASE_URL` / `INSFORGE_ANON_KEY` are absent, audit is *disabled* (not silently failing): `persistRun` is skipped and a single `audit_status { state: 'failed', detail: 'audit disabled — no Insforge configured' }` is emitted so the absence of an audit trail is explicit on screen, never mistaken for a saved record.

---

### 2. Daytona — Sandboxed Calculation

**Package:** `@daytona/sdk` (per official docs at daytona.io/docs; verify against npm at install time)

**Sandbox lifecycle** (`lib/integrations/daytona.ts`):
```typescript
import { Daytona } from '@daytona/sdk';

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_SERVER_URL,
});

// One sandbox per request; created at route start, deleted on done/error
export async function createCalcSandbox(): Promise<Sandbox> {
  return daytona.create({ language: 'typescript' });
}

export async function runInSandbox(
  sandbox: Sandbox,
  code: string
): Promise<{ result: string; exitCode: number; ms: number }> {
  const t0 = Date.now();
  const response = await sandbox.process.codeRun(code);
  return { result: response.result, exitCode: response.exitCode, ms: Date.now() - t0 };
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  try { await sandbox.delete(); } catch { /* best-effort */ }
}
```

**Usage in `calculator.ts`:**

The existing `calculateFormulation()` function is refactored to accept an optional `sandbox` parameter. When present, it serialises its decimal.js computation as a self-contained TypeScript snippet and runs it via `runInSandbox()`; the returned JSON string is parsed back into the `CalculationResult` type. When no sandbox is provided (fallback path), the calculation runs in-process as before.

```typescript
// Snippet sent to Daytona sandbox — no imports needed, runtime has decimal.js
const snippet = `
  import Decimal from 'decimal.js';
  const result = {
    ketoprofen: new Decimal('${ingredientGrams}').div('${totalGrams}').mul(100).toFixed(4)
  };
  console.log(JSON.stringify(result));
`;
```

Both the Drafter and Reviewer share the same sandbox instance created at route start. The Reviewer's `calculate_formulation` call goes through the same sandbox, making it a genuinely independent recompute in an isolated environment.

**Events emitted around each sandbox call:**
```
{ type: 'sandbox_exec',   code: snippet, sandbox_id: sandbox.id }
{ type: 'sandbox_result', result: '{"ketoprofen":"0.5000"}', exit_code: 0, ms: 312 }
```

**Graceful degradation:** If `DAYTONA_API_KEY` is absent or `createCalcSandbox()` throws, `calculator.ts` falls back to in-process decimal.js. No `sandbox_exec`/`sandbox_result` events are emitted in fallback mode. The deterministic `compare_concentrations` check in app code runs either way.

---

### 3. Rtrvr.ai — Regulatory & Compliance Cache

**This integration is NOT on the live request path.** It runs as a standalone script only.

The script makes two Rtrvr agent calls: one for USP `<795>` BUD guidance (for Reviewer rationale text), one for the FDA difficult-to-compound / withdrawn-for-safety list (for the compliance gate).

**API call pattern** (`lib/integrations/rtrvr.ts`):
```typescript
// POST https://api.rtrvr.ai/agent
async function callRtrvr(input: string, urls: string[]): Promise<unknown> {
  const res = await fetch('https://api.rtrvr.ai/agent', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RTRVR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, urls, response: { verbosity: 'final' } }),
  });
  if (!res.ok) throw new Error(`Rtrvr error ${res.status}`);
  const data = await res.json();
  return data.result?.json ?? data.result;
}
```

**Two cache outputs written by the script:**

`cache/regulatory.json` — BUD rationale text used in Reviewer reference pack (not for engine calculations; the engine uses `bud_rules.json`):
```json
{
  "fetched_at": "2026-05-31T12:00:00Z",
  "source": "rtrvr.ai / USP <795> (Nov 1, 2023)",
  "rationale_text": "USP <795> (effective Nov 1, 2023) defines BUD for nonpreserved aqueous as 14 days refrigerated..."
}
```

`cache/fda-list.json` — FDA difficult-to-compound list used by the compliance gate:
```json
{
  "fetched_at": "2026-05-31T12:00:00Z",
  "source": "rtrvr.ai / FDA 503A Bulks List",
  "ineligible": [
    { "name": "estriol", "reason": "On FDA 503A difficult-to-compound list" }
  ]
}
```

**Script** (`scripts/refresh-regulatory-cache.ts`):
```bash
npx ts-node scripts/refresh-regulatory-cache.ts
```
Run manually before a demo. The `cache/` directory is gitignored. **Do not commit** either cache file — they may contain full-text regulatory content.

**Cache readers (7-day stale threshold) — two different failure postures:**

- `stability-db.ts` → `getRegulatoryRules()`: **fail-open is acceptable.** This feeds the Reviewer's *rationale text* only; the deterministic BUD math comes from `bud_rules.json` regardless. Reads `cache/regulatory.json`, falls back to bundled rationale text.
- `compliance-gate.ts` → `getFDAList()`: **fail-closed.** This backs a patient-safety hard stop, so a missing/stale/unparsable cache must NOT silently degrade to a pass. It returns a *result* carrying provenance, and the gate blocks the request unless the list is confirmed fresh-and-authoritative.

```typescript
// Generic fail-OPEN reader — only for non-safety rationale text.
function readCacheOpen<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const cached = JSON.parse(readFileSync(path, 'utf-8'));
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return fallback;
    return cached;
  } catch { return fallback; }
}

// Compliance reader — fail-CLOSED. Never returns a usable list silently;
// it returns the list AND its provenance so the gate can decide to block.
type FDAListResult = {
  ineligible: { name: string; reason: string }[];
  origin: 'fda_cache' | 'static_fallback';
  fetched_at: string | null;
  stale: boolean;
  authoritative: boolean;   // true only for a fresh, parsed cache/fda-list.json
};

function getFDAList(): FDAListResult {
  try {
    if (existsSync(CACHE_FDA_PATH)) {
      const cached = JSON.parse(readFileSync(CACHE_FDA_PATH, 'utf-8'));
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      const stale = age > 7 * 24 * 60 * 60 * 1000;
      return {
        ineligible: cached.ineligible ?? [],
        origin: 'fda_cache',
        fetched_at: cached.fetched_at,
        stale,
        authoritative: !stale,
      };
    }
  } catch { /* fall through to static fallback below */ }

  // No fresh authoritative cache. Load the static list ONLY as data, marked non-authoritative.
  const fb = JSON.parse(readFileSync(FALLBACK_FDA_PATH, 'utf-8'));
  return {
    ineligible: fb.ineligible ?? [],
    origin: 'static_fallback',
    fetched_at: fb.updated ?? null,
    stale: true,
    authoritative: false,
  };
}
```

**Compliance gate decision logic (`compliance-gate.ts`):**

```typescript
function checkCompliance(drug: string): ComplianceResult {
  const list = getFDAList();
  const hit = list.ineligible.find(e => matchesDrug(e.name, drug));

  // A positive match always blocks, regardless of source — the static fallback
  // can only ADD known-bad drugs, never clear one.
  if (hit) {
    return { eligible: false, status: 'ineligible', drug, reason: hit.reason, source: provenance(list) };
  }

  // No match. We may only PASS on an authoritative list. If the list is a stale
  // or static fallback, "not found" is not trustworthy — a newly-listed drug
  // would be a false negative — so fail closed.
  if (!list.authoritative && !DEMO_OFFLINE_MODE) {
    return {
      eligible: false, status: 'unverifiable', drug,
      reason: 'FDA difficult-to-compound list could not be confirmed current; refusing to certify eligibility. Run scripts/refresh-regulatory-cache.ts.',
      source: provenance(list),
    };
  }

  return { eligible: true, status: 'eligible', drug, source: provenance(list) };
}
```

- `DEMO_OFFLINE_MODE` is an **explicit, opt-in** env flag (e.g. `DEMO_OFFLINE_MODE=true`) for running the demo with no network/cache. When set, an unverifiable "not found" is allowed to pass **but** is still emitted with `origin: 'static_fallback'`, `stale: true`, and the UI banner makes clear the eligibility check ran against an unverified offline list. It is never the default.

---

## Error Handling & Fallback

| Failure | Behaviour |
|---|---|
| Drug on FDA list | `compliance_result { eligible: false, status: 'ineligible' }` emitted; stream closes; no MFR drafted |
| FDA list cannot be confirmed fresh (cache missing/stale/unparsable) and not in `DEMO_OFFLINE_MODE` | **Fail closed:** `compliance_result { eligible: false, status: 'unverifiable' }` emitted; stream closes; no MFR drafted; UI shows "regulatory data unavailable — refresh cache" |
| openFDA down | Use ingredient name as-is; note "label data unavailable" in MFR |
| Daytona unavailable / `DAYTONA_API_KEY` missing | Fall back to in-process decimal.js; no `sandbox_*` events emitted; `reconcile()` still runs |
| Insforge write fails | Retried up to 3× via the idempotent `persist_run` RPC; if still failing, `audit_status { state: 'failed' }` is emitted **before** `done` and shown to the operator (record marked not-signed-off). `mfr_runs` and `agent_decisions` never diverge — the RPC is one transaction. |
| `INSFORGE_*` env vars missing | Audit disabled; `audit_status { state: 'failed', detail: 'audit disabled' }` emitted so the missing trail is explicit, not silent |
| `cache/regulatory.json` missing or stale | `getRegulatoryRules()` returns `data/bud_rules.json` fallback |
| `cache/fda-list.json` missing or stale | `getFDAList()` returns the static list marked `authoritative: false`; the gate **fails closed** (blocks with `status: 'unverifiable'`) unless `DEMO_OFFLINE_MODE=true`. The static list can only *add* known-bad drugs (a positive match still blocks), never certify a "not found" pass. |
| Rtrvr API error in script | Script logs and exits non-zero; cache not written; no impact on app |
| Full SSE stream error | Emit `{ type: 'error', message }` and close; client shows error state |
| Demo day network failure | `?fallback=true` replays `fallback-events.ts` with delays; no network required |

---

## Environment Variables

```bash
# .env.example
ANTHROPIC_API_KEY=                  # Required
DAYTONA_API_KEY=                    # Optional — falls back to in-process math
DAYTONA_SERVER_URL=                 # Optional — defaults to https://app.daytona.io/api
INSFORGE_BASE_URL=                  # Optional — e.g. https://your-project.us-east.insforge.app
INSFORGE_ANON_KEY=                  # Optional — anon key from InsForge dashboard
RTRVR_API_KEY=                      # Optional — only needed to run refresh-regulatory-cache.ts
DEMO_OFFLINE_MODE=                   # Optional — set true ONLY to allow eligibility passes against the
                                    #   static fallback list when no fresh FDA cache exists. Never set in
                                    #   any environment that could be mistaken for real use. Default: unset.
```

All three sponsor integrations are optional at runtime. With only `ANTHROPIC_API_KEY` set, the math runs in-process and audit is skipped. **However, the compliance gate fails closed by default:** with no fresh `cache/fda-list.json`, a clean-formula run is blocked with `status: 'unverifiable'` until you either run `scripts/refresh-regulatory-cache.ts` or explicitly set `DEMO_OFFLINE_MODE=true` to accept the unverified static list for an offline demo.

---

## MFR Sections

Standard USP 795 Master Formulation Record sections the drafter fills in order:

1. Formula identification (name, strength, dosage form, formula ID)
2. Ingredients list (name, quantity, grade, supplier placeholder)
3. Compounding calculations (scaling, concentrations, shown work)
4. Equipment & procedure
5. Quality checks (pH target, appearance, weight)
6. Beyond-use date with rule citation
7. Storage conditions

---

## What Is Not In Scope

- USP 797 sterile preparations
- PDF export (browser print CSS is acceptable if time permits; no server-side PDF pipeline)
- User authentication
- Formula history UI (runs are persisted to Insforge but not surfaced in the UI)
- Multi-user / team workflows
- Live Rtrvr call on the request path (cache-refresh script only)
- Persistent Daytona sandboxes across requests (one sandbox per request, torn down on completion)
- Full corpus injection into agent prompts (always scoped to one reference pack entry per category)
