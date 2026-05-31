# Syntha — Formulation & BUD Copilot: Design Spec

**Date:** 2026-05-31  
**Status:** Approved — updated with sponsor tool integrations  
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
Phase 1: Drafter agent   — Claude call #1, tool loop, emits mfr_section events
Phase 2: Reviewer agent  — Claude call #2, fresh context, artifact-only input, emits qa_finding events
  ↓
SSE stream closes → client renders final document + QA panel
```

**Independence contract:** The reviewer is a brand-new `anthropic.messages.create()` call. It receives only the serialized MFR artifact (sections + stated values) and the original prescription (ordered strength) — no drafter messages, no drafter tool results. It re-runs every calculation with its own tool calls. The deterministic catch is a hard `Decimal.equals()` comparison in `compare_concentrations` — the model doesn't decide whether numbers match, code does.

**Runtime:** Demo from `localhost` (`npm run dev`). Avoids all serverless timeout concerns from two sequential tool-use loops.

---

## File Structure

```
app/
  page.tsx                          # Main UI (single page)
  api/generate/route.ts             # Streaming SSE endpoint

lib/
  agents/
    drafter.ts                      # Drafter: Claude call #1 + tool dispatch
    reviewer.ts                     # Reviewer: Claude call #2 + tool dispatch
  tools/
    drug-resolver.ts                # openFDA /drug/label.json REST call
    calculator.ts                   # decimal.js: quantities, concentrations (runs in Daytona)
    stability-db.ts                 # stability.json lookup + Rtrvr cache fallback
    bud-engine.ts                   # USP 795 decision tree (code, not model)
    mfr-builder.ts                  # Structured MFR section assembler
    qa-checker.ts                   # compare_concentrations (deterministic; app code only)
  integrations/
    daytona.ts                      # Sandbox lifecycle: create, codeRun wrapper, delete
    insforge.ts                     # InsForge client + audit write helpers
    rtrvr.ts                        # Rtrvr agent call + cache normalizer (script use only)
  data/
    stability.json                  # ~12 ingredients, real values + provenance (static fallback)
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
  refresh-regulatory-cache.ts       # Standalone: calls Rtrvr, writes cache/regulatory.json

cache/                              # Runtime-only, gitignored
  regulatory.json                   # Rtrvr-fetched USP guidance, normalized
```

---

## Typed Event Stream

Every SSE message is a JSON-encoded `StreamEvent`. The UI reacts to each type independently.

```typescript
type StreamEvent =
  | { type: 'agent_start';    agent: 'drafter' | 'reviewer' }
  | { type: 'tool_call';      tool: string; input: unknown }
  | { type: 'tool_result';    tool: string; output: unknown; ms: number }
  | { type: 'sandbox_exec';   code: string; sandbox_id: string }      // Daytona: code sent to sandbox
  | { type: 'sandbox_result'; result: string; exit_code: number; ms: number } // Daytona: result back
  | { type: 'text_delta';     delta: string }
  | { type: 'mfr_section';    section: MFRSectionName; content: string }
  | { type: 'qa_finding';     severity: 'pass' | 'error' | 'warning';
                               field: string; stated: string; computed: string; message: string }
  | { type: 'qa_signoff';     passed: boolean; summary: string }
  | { type: 'audit_written';  run_id: string }                        // Insforge: confirmation (non-blocking)
  | { type: 'done' }
  | { type: 'error';          message: string }
```

`mfr_section` events populate the document panel as they arrive. `qa_finding` events populate the QA panel. `tool_call`/`tool_result` events feed the live work log. `sandbox_exec`/`sandbox_result` make isolated math visible in the work panel. `audit_written` is emitted after the stream closes (fire-and-forget) and is display-only.

---

## Drafter Agent Tools

| Tool | Source | Notes |
|---|---|---|
| `resolve_drug` | openFDA `/drug/label.json` | One live API call; real credibility |
| `calculate_formulation` | `decimal.js` | Quantities, concentrations — no floats |
| `lookup_stability` | `stability.json` | Real USP/literature values, provenance noted |
| `compute_bud` | USP 795 decision tree | Code, not model judgment |
| `fill_mfr_section` | Template assembler | Returns `{ section, content }` |

### USP 795 BUD Decision Tree

```
aqueous + oral          → 14 days refrigerated          [USP <795> Table 1]
aqueous + topical/semi  → 30 days RT                    [USP <795> Table 1]
                           (35 days if stability data supports extension)
non-aqueous             → min(180 days, stability_data.bud_days)
all types               → further limited by ingredient stability_data.bud_days
```

Every BUD output carries a `rule_citation` string identifying which branch fired.

---

## Reviewer Agent

**Input (user message only):** serialized MFR JSON (stated values) + original prescription (ordered strength). Nothing from the drafter's context.

**Tools available:** `calculate_formulation`, `compute_bud`, `compare_concentrations`

### Deterministic Concentration Check

```typescript
function compare_concentrations(
  stated: ConcentrationMap,
  computed: ConcentrationMap
): QAFinding[] {
  return Object.entries(stated).flatMap(([ingredient, statedPct]) => {
    const computedPct = computed[ingredient];
    return new Decimal(statedPct).equals(new Decimal(computedPct))
      ? [{ severity: 'pass', field: `${ingredient} concentration`,
           stated: `${statedPct}%`, computed: `${computedPct}%`,
           message: 'Concentration verified ✓' }]
      : [{ severity: 'error', field: `${ingredient} concentration`,
           stated: `${statedPct}%`, computed: `${computedPct}%`,
           message: `Stated ${statedPct}% does not match computed ${computedPct}%` }];
  });
}
```

The model decides which values to pass in. The comparison is code.

---

## Demo Scenarios

### Scenario A — Hydrocortisone 1% Cream (clean pass)

- **Input:** HC 1.0 g, cream base q.s. 100 g, semisolid, aqueous
- **BUD:** 30 days RT per USP `<795>` Table 1
- **Reviewer:** 1.0 g ÷ 100 g = 1.0% = ordered 1% ✓
- **Outcome:** QA sign-off PASSED

### Scenario B — Ketoprofen 5% PLO Gel (planted decimal error)

- **Input:** Ordered strength 5%, ingredient weight listed as 0.5 g (should be 5.0 g), batch 100 g
- **Error class:** Decimal slip — the single most common real-world compounding error
- **Drafter:** Creates MFR faithfully from input, states ketoprofen 0.5 g, derived concentration 0.5%
- **Reviewer:** Recomputes 0.5 g ÷ 100 g = 0.5% ≠ ordered 5% → `qa_finding` severity `error`
- **Finding message:** *"Stated concentration 0.5% does not match ordered strength 5%. This is a 10× underdose."*
- **Outcome:** QA sign-off FAILED — cannot proceed

Both scenarios are pre-loaded as one-click buttons on the input form. No manual typing during the demo.

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

## Stability Data

`stability.json` covers ~12 common non-sterile compounding ingredients. Each entry has:

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

Provenance field means the answer to "is this made up?" is: *"No, it's a curated subset of real published values."*

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

**Write pattern** — non-blocking, fire-and-forget after SSE `done`:
```typescript
// Called after stream closes; errors logged but never thrown
async function persistRun(run: AuditRun): Promise<void> {
  try {
    const { data, error } = await insforge.database
      .from('mfr_runs')
      .insert({
        formula: run.formula,
        mfr: run.mfr,
        bud: run.bud,
        passed: run.passed,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
      })
      .select()
      .single();
    if (error || !data) throw error;

    const decisions = run.events.map((e, idx) => ({
      run_id: data.id,
      idx,
      agent: e.agent,
      kind: e.type,
      payload: e,
      ts: e.ts,
    }));
    await insforge.database.from('agent_decisions').insert(decisions);
  } catch (err) {
    console.error('[insforge] audit write failed:', err);
  }
}
```

**Graceful degradation:** If `INSFORGE_BASE_URL` / `INSFORGE_ANON_KEY` are absent, `persistRun` is a no-op. The user-facing stream is never affected.

---

### 2. Daytona — Sandboxed Calculation

**Package:** `@daytonaio/sdk` (verify exact name against npm at install time; docs import as `@daytona/sdk`)

**Sandbox lifecycle** (`lib/integrations/daytona.ts`):
```typescript
import { Daytona } from '@daytonaio/sdk';

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

### 3. Rtrvr.ai — Regulatory Cache

**This integration is NOT on the live request path.** It runs as a standalone script.

**API call** (`lib/integrations/rtrvr.ts`):
```typescript
// POST https://api.rtrvr.ai/agent
const res = await fetch('https://api.rtrvr.ai/agent', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.RTRVR_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    input: 'Retrieve the current USP <795> beyond-use date defaults for non-sterile preparations. Extract: BUD limits by formulation type (aqueous oral, aqueous topical/semisolid, non-aqueous), storage conditions, and any 2024–2026 revision notes.',
    urls: ['https://www.usp.org/compounding/general-chapter-795'],
    response: { verbosity: 'final' },
  }),
});
const data = await res.json();
```

**Cache normalizer** writes `cache/regulatory.json`:
```json
{
  "fetched_at": "2026-05-31T12:00:00Z",
  "source": "rtrvr.ai / USP <795>",
  "bud_rules": [
    { "type": "aqueous_oral",    "days": 14, "storage": "refrigerated", "citation": "USP <795> Table 1" },
    { "type": "aqueous_topical", "days": 30, "storage": "room_temp",    "citation": "USP <795> Table 1" },
    { "type": "non_aqueous",     "days": 180,"storage": "room_temp",    "citation": "USP <795> Table 1" }
  ]
}
```

**Script** (`scripts/refresh-regulatory-cache.ts`):
```bash
npx ts-node scripts/refresh-regulatory-cache.ts
```
Run manually before a demo or on a schedule. The `cache/` directory is gitignored.

**Reviewer reads cached JSON** in `lib/tools/stability-db.ts`:
```typescript
import { readFileSync, existsSync } from 'fs';
import staticRules from '@/lib/data/stability.json';

export function getRegulatoryRules() {
  try {
    const cachePath = 'cache/regulatory.json';
    if (!existsSync(cachePath)) return staticRules.bud_rules;
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    // Stale if > 7 days
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return staticRules.bud_rules;
    return cached.bud_rules;
  } catch {
    return staticRules.bud_rules;
  }
}
```

**Do not commit** `cache/regulatory.json` — it may contain full-text regulatory content.

---

## Error Handling & Fallback

| Failure | Behaviour |
|---|---|
| openFDA down | Use ingredient name as-is; note "label data unavailable" in MFR |
| Daytona unavailable / `DAYTONA_API_KEY` missing | Fall back to in-process decimal.js; no `sandbox_*` events emitted |
| Insforge write fails | Log error, continue; stream already closed; never surfaces to user |
| `INSFORGE_*` env vars missing | `persistRun` is a no-op |
| `cache/regulatory.json` missing or stale | `getRegulatoryRules()` returns static `stability.json` fallback |
| Rtrvr API error in script | Script logs and exits non-zero; cache file not written; no impact on app |
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
```

All three sponsor integrations are optional at runtime. The clean-formula demo runs end-to-end with only `ANTHROPIC_API_KEY` set (math runs in-process, audit skipped, static regulatory JSON used).

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
