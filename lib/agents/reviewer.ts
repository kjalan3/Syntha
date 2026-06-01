import Anthropic from '@anthropic-ai/sdk';
import { REVIEWER_TOOLS, dispatchTool } from '@/lib/agents/anthropic-tools';
import { reconcile } from '@/lib/tools/qa-checker';
import { checkCompliance } from '@/lib/tools/compliance-gate';
import type { SandboxRunner } from '@/lib/tools/calculator';
import type { Prescription, ReferencePack, StreamEvent, QAFinding } from '@/lib/types';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export interface SignoffInput {
  computedPct: string;
  statedPct: string;
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
