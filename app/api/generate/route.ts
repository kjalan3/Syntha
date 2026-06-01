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

        const sandbox = await createCalcSandbox();
        const runId = randomUUID();

        try {
          const pack = buildReferencePack(rx);
          const draft = await runDrafter(rx, pack, emit, sandbox ?? undefined);

          const mfrArtifact = Object.entries(draft.sections)
            .map(([k, v]) => `## ${k}\n${v}`)
            .join('\n\n');
          const { computedPct } = await runReviewer(rx, mfrArtifact, pack, emit, sandbox ?? undefined);

          const statedPct = draft.statedConcentrationPct ?? computedPct;
          const signoff = runSignoff(rx, { computedPct, statedPct });
          for (const f of signoff.findings) emit({ type: 'qa_finding', ...f });
          emit({ type: 'qa_signoff', passed: signoff.passed, summary: signoff.summary });

          emit({ type: 'audit_status', run_id: runId, state: 'pending' });
          const finishedAt = new Date().toISOString();
          const auditRun: AuditRun = {
            id: runId, formula: rx,
            mfr: draft.sections as Record<MFRSectionName, string>,
            bud: draft.bud, passed: signoff.passed,
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
