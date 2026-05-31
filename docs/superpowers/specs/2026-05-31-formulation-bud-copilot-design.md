# Syntha — Formulation & BUD Copilot: Design Spec

**Date:** 2026-05-31  
**Status:** Approved  
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
    calculator.ts                   # decimal.js: quantities, concentrations
    stability-db.ts                 # stability.json lookup
    bud-engine.ts                   # USP 795 decision tree (code, not model)
    mfr-builder.ts                  # Structured MFR section assembler
    qa-checker.ts                   # compare_concentrations (deterministic)
  data/
    stability.json                  # ~12 ingredients, real values + provenance
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
```

---

## Typed Event Stream

Every SSE message is a JSON-encoded `StreamEvent`. The UI reacts to each type independently.

```typescript
type StreamEvent =
  | { type: 'agent_start';  agent: 'drafter' | 'reviewer' }
  | { type: 'tool_call';    tool: string; input: unknown }
  | { type: 'tool_result';  tool: string; output: unknown; ms: number }
  | { type: 'text_delta';   delta: string }
  | { type: 'mfr_section';  section: MFRSectionName; content: string }
  | { type: 'qa_finding';   severity: 'pass' | 'error' | 'warning';
                             field: string; stated: string; computed: string; message: string }
  | { type: 'qa_signoff';   passed: boolean; summary: string }
  | { type: 'done' }
  | { type: 'error';        message: string }
```

`mfr_section` events populate the document panel as they arrive. `qa_finding` events populate the QA panel. `tool_call`/`tool_result` events feed the live work log.

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

## Error Handling & Fallback

- **openFDA failure:** Fall back to ingredient name as-is; note "label data unavailable" in MFR.
- **Stream error:** Emit `{ type: 'error', message }` and close; client shows error state.
- **Demo fallback:** `?fallback=true` on the generate route replays `fallback-events.ts` with artificial delays instead of hitting the API. No network required.

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
- Persistent storage / formula history
- Multi-user / team workflows
