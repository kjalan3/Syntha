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
