import Anthropic from '@anthropic-ai/sdk';
import { DRAFTER_TOOLS, dispatchTool } from '@/lib/agents/anthropic-tools';
import type { SandboxRunner } from '@/lib/tools/calculator';
import type { Prescription, ReferencePack, StreamEvent, MFRSectionName, BudResult } from '@/lib/types';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export interface DrafterResult {
  sections: Partial<Record<MFRSectionName, string>>;
  statedConcentrationPct: string | null;
  bud: BudResult | null;
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
  let bud: BudResult | null = null;

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
      if (tu.name === 'compute_bud' && typeof (output as { bud_days?: unknown }).bud_days === 'number') {
        bud = output as BudResult;
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

  return { sections, statedConcentrationPct, bud };
}
