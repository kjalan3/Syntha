import type { AuditRun } from '@/lib/types';

interface InsforgeClient {
  database: { rpc: (fn: string, args: unknown) => Promise<{ error: unknown }> };
}

interface PersistOpts {
  client?: InsforgeClient | null; // injectable for tests
}

// Memoized for the process lifetime, including a null result (fine for serverless/demo
// cold-start; if env is set later in the same long-lived process, reload the module).
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
  // @ts-expect-error optional dependency not installed
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
